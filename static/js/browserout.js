const BROWSER_PLAYER_KEY = "__browser__";
const BROWSER_OUT_KEY = "mpd-browser-out";

let browserOutEnabled = localStorage.getItem(BROWSER_OUT_KEY) === "1";
let browserAudio = null;
let browserQueue = [];
let browserIndex = 0;
let browserNow = null;
let browserPrimePromise = null;

// Tiny silent WAV — unlocks autoplay after a user tap (before async fetch).
const BROWSER_SILENT_WAV =
    "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA";

function getBrowserAudio() {
    if (browserAudio) return browserAudio;
    browserAudio = document.getElementById("browserAudio");
    if (!browserAudio) {
        browserAudio = document.createElement("audio");
        browserAudio.id = "browserAudio";
        browserAudio.preload = "auto";
        browserAudio.playsInline = true;
        browserAudio.setAttribute("playsinline", "");
        browserAudio.setAttribute("webkit-playsinline", "");
        document.body.appendChild(browserAudio);
    }
    if (!browserAudio._mpdBound) {
        browserAudio._mpdBound = true;
        browserAudio.addEventListener("ended", onBrowserTrackEnded);
    }
    return browserAudio;
}

/** Call synchronously from click handlers before any await. */
function primeBrowserAudio() {
    const a = getBrowserAudio();
    if (a._mpdPrimed && !a.paused) return Promise.resolve();
    const prev = a.src;
    if (!prev) {
        a.src = BROWSER_SILENT_WAV;
    }
    browserPrimePromise = a.play().then(function() {
        a._mpdPrimed = true;
        if (!prev || prev.indexOf("data:audio") === 0) {
            a.pause();
        }
    }).catch(function() {
        a._mpdPrimed = false;
    });
    return browserPrimePromise;
}

async function playBrowserMedia(a) {
    if (browserPrimePromise) {
        try { await browserPrimePromise; } catch (e) {}
    }
    try {
        await a.play();
        updatePlayPauseButton("play");
        return true;
    } catch (e) {
        updatePlayPauseButton("pause");
        if (typeof flashPlayerAction === "function") {
            flashPlayerAction("Tap ▶ to start sound");
        }
        return false;
    }
}

function isBrowserOutput() {
    return !!browserOutEnabled;
}

function getBrowserNow() {
    return browserNow;
}

function streamUrlForFile(file) {
    return "/api/dlna/stream?file=" + encodeURIComponent(file);
}

function shortNameFromPath(path) {
    if (!path) return "";
    const parts = path.split("/");
    return parts[parts.length - 1] || path;
}

function setBrowserOutput(on) {
    browserOutEnabled = !!on;
    localStorage.setItem(BROWSER_OUT_KEY, browserOutEnabled ? "1" : "0");
    updateBrowserOutputUI();
    if (!browserOutEnabled) {
        const a = getBrowserAudio();
        a.pause();
        a.removeAttribute("src");
        a.load();
        browserQueue = [];
        browserIndex = 0;
        browserNow = null;
        if (typeof flashPlayerAction === "function") {
            flashPlayerAction("Browser output off");
        }
        if (typeof refresh === "function") refresh();
        return;
    }
    if (typeof flashPlayerAction === "function") {
        flashPlayerAction("This browser (independent)");
    }
}

function updateBrowserOutputUI() {
    const btn = document.getElementById("browserOutBtn");
    if (btn) btn.classList.toggle("active", browserOutEnabled);
    const sel = document.getElementById("playerSelect");
    if (!sel) return;
    const has = Array.prototype.some.call(sel.options, function(o) {
        return o.value === BROWSER_PLAYER_KEY;
    });
    if (!has) {
        const opt = document.createElement("option");
        opt.value = BROWSER_PLAYER_KEY;
        opt.innerText = "This browser";
        sel.insertBefore(opt, sel.firstChild);
    }
    if (browserOutEnabled) sel.value = BROWSER_PLAYER_KEY;
}

function normalizeBrowserItems(items) {
    return (items || []).map(function(item) {
        if (typeof item === "string") {
            return {file: item, title: "", artist: "", album: ""};
        }
        return {
            file: item.file || item.path || "",
            title: item.title || "",
            artist: item.artist || "",
            album: item.album || ""
        };
    }).filter(function(item) { return !!item.file; });
}

function playBrowserQueue(items, startIndex) {
    primeBrowserAudio();
    browserQueue = normalizeBrowserItems(items);
    browserIndex = Math.max(0, Math.min(startIndex || 0, browserQueue.length - 1));
    if (!browserQueue.length) {
        if (typeof flashPlayerAction === "function") flashPlayerAction("Nothing to play");
        return Promise.resolve();
    }
    if (!browserOutEnabled) setBrowserOutput(true);
    return playBrowserIndex(browserIndex);
}

async function playBrowserIndex(idx) {
    if (!browserQueue.length) return;
    browserIndex = (idx + browserQueue.length) % browserQueue.length;
    const item = browserQueue[browserIndex];
    browserNow = {
        file: item.file,
        title: item.title || shortNameFromPath(item.file),
        artist: item.artist || "",
        album: item.album || ""
    };
    const a = getBrowserAudio();
    a.src = streamUrlForFile(item.file);
    a.load();
    await playBrowserMedia(a);
    applyBrowserNowToUI();
}

async function browserPlayPath(path) {
    if (!path) return;
    primeBrowserAudio();
    let files = [];
    try {
        const data = await api("/api/foldertracks?path=" + encodeURIComponent(path) + "&limit=500");
        files = data.tracks || [];
    } catch (e) {}
    if (!files.length) {
        try {
            const data = await api("/api/browse?path=" + encodeURIComponent(path));
            if (Array.isArray(data) && data.length) {
                files = data.filter(function(i) { return i.type === "file" && i.path; }).map(function(i) {
                    return {
                        file: i.path,
                        title: i.title || "",
                        artist: i.artist || "",
                        album: i.album || ""
                    };
                });
            }
        } catch (e2) {}
    }
    if (!files.length) {
        files = [{file: path, title: "", artist: "", album: ""}];
    }
    return playBrowserQueue(files, 0);
}

async function browserAddPath(path) {
    if (!path) return;
    primeBrowserAudio();
    let files = [];
    try {
        const data = await api("/api/foldertracks?path=" + encodeURIComponent(path) + "&limit=500");
        files = data.tracks || [];
    } catch (e) {}
    if (!files.length) {
        try {
            const data = await api("/api/browse?path=" + encodeURIComponent(path));
            if (Array.isArray(data) && data.length) {
                files = data.filter(function(i) { return i.type === "file" && i.path; }).map(function(i) {
                    return {
                        file: i.path,
                        title: i.title || "",
                        artist: i.artist || "",
                        album: i.album || ""
                    };
                });
            }
        } catch (e2) {}
    }
    if (!files.length) files = [{file: path}];
    const items = normalizeBrowserItems(files);
    if (!browserOutEnabled) setBrowserOutput(true);
    const wasEmpty = !browserQueue.length;
    browserQueue = browserQueue.concat(items);
    if (wasEmpty) await playBrowserIndex(0);
    else if (typeof flashPlayerAction === "function") {
        flashPlayerAction("Added " + items.length + " to browser queue");
    }
}

async function browserRadio(mode, count) {
    primeBrowserAudio();
    const seed = getBrowserNow();
    if (!seed || !seed.file) {
        if (typeof flashPlayerAction === "function") {
            flashPlayerAction("Play a track first, then start radio");
        } else {
            alert("Play a track first, then start radio");
        }
        return null;
    }
    const exclude = browserQueue.map(function(t) { return t.file; }).filter(Boolean).slice(0, 300);
    const endpoint = mode === "smart" ? "/api/smartradio" : (mode === "similar" ? "/api/similar" : "/api/radio/start");
    const body = {
        browser: true,
        seed_file: seed.file,
        count: count || (mode === "similar" ? 10 : 15),
        exclude: exclude
    };
    if (endpoint === "/api/radio/start") {
        body.mode = mode === "smart" ? "smart" : "local";
    }
    const res = await api(endpoint, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(body)
    });
    const tracks = res.tracks || [];
    if (!tracks.length) {
        if (typeof flashPlayerAction === "function") flashPlayerAction("No radio tracks found");
        else alert("No radio tracks found");
        return res;
    }
    // Keep current track, append radio picks and continue (or start from first new)
    const startAt = browserQueue.length;
    browserQueue = browserQueue.concat(normalizeBrowserItems(tracks));
    if (!browserOutEnabled) setBrowserOutput(true);
    if (getBrowserAudio().paused || !browserNow) {
        await playBrowserIndex(startAt > 0 ? startAt : 0);
    } else if (typeof flashPlayerAction === "function") {
        flashPlayerAction("Radio +" + tracks.length + " · " + (res.source || mode));
    }
    return res;
}

async function browserPlayAlbum(al) {
    primeBrowserAudio();
    const tracks = await api(
        "/api/albumtracks?album=" + encodeURIComponent(al.album) +
        "&albumartist=" + encodeURIComponent(al.albumartist || "")
    );
    return playBrowserQueue(tracks || [], 0);
}

function onBrowserTrackEnded() {
    if (!browserOutEnabled) return;
    if (browserIndex < browserQueue.length - 1) {
        playBrowserIndex(browserIndex + 1);
    } else {
        updatePlayPauseButton("stop");
    }
}

async function browserTogglePlayPause() {
    primeBrowserAudio();
    const a = getBrowserAudio();
    if (!browserNow || !a.src || String(a.src).indexOf("data:audio") === 0) {
        if (browserQueue.length) await playBrowserIndex(browserIndex);
        else if (typeof flashPlayerAction === "function") {
            flashPlayerAction("Pick a track in Browser mode");
        }
        return;
    }
    if (a.paused) {
        await playBrowserMedia(a);
        applyBrowserNowToUI();
    } else {
        a.pause();
        updatePlayPauseButton("pause");
    }
}

async function browserStop() {
    const a = getBrowserAudio();
    a.pause();
    try { a.currentTime = 0; } catch (e) {}
    updatePlayPauseButton("stop");
}

async function browserCmd(name) {
    if (name === "stop") {
        await browserStop();
        return;
    }
    if (name === "next") {
        if (!browserQueue.length) return;
        await playBrowserIndex(browserIndex + 1);
        return;
    }
    if (name === "previous") {
        if (!browserQueue.length) return;
        const a = getBrowserAudio();
        if (a.currentTime > 3) {
            try { a.currentTime = 0; } catch (e) {}
            return;
        }
        await playBrowserIndex(browserIndex - 1);
    }
}

function applyBrowserNowToUI() {
    if (!browserOutEnabled || !browserNow) return;
    const title = browserNow.title || shortNameFromPath(browserNow.file);
    const set = function(id, text) {
        const el = document.getElementById(id);
        if (el) el.innerText = text;
    };
    set("title", title);
    set("artist", browserNow.artist || "This browser");
    set("album", browserNow.album || "");
    set("heroTitle", title);
    set("heroArtist", browserNow.artist || "This browser");
    set("heroAlbum", browserNow.album || "");
    const status = document.getElementById("status");
    if (status) {
        const a = getBrowserAudio();
        const elapsed = Math.floor(a.currentTime || 0);
        const duration = Math.floor(a.duration || 0) || 0;
        status.innerText = (a.paused ? "pause" : "play") + " · browser · " +
            elapsed + (duration ? ("/" + duration) : "");
    }
    const cover = document.getElementById("coverArt");
    const heroCover = document.getElementById("heroCover");
    const heroPlaceholder = document.getElementById("heroPlaceholder");
    if (typeof mobileCoversEnabled === "function" && !mobileCoversEnabled()) {
        if (cover) {
            cover.classList.add("hidden");
            cover.removeAttribute("src");
        }
        return;
    }
    const coverUrl = "/api/cover?disk=1&file=" + encodeURIComponent(browserNow.file);
    if (cover) {
        cover.classList && cover.classList.remove("hidden");
        cover.style.display = "block";
        cover.src = coverUrl;
    }
    if (heroCover) {
        heroCover.style.display = "block";
        heroCover.src = coverUrl;
        if (heroPlaceholder) heroPlaceholder.style.display = "none";
    }
    updatePlayPauseButton(getBrowserAudio().paused ? "pause" : "play");
}

function toggleBrowserOutput() {
    setBrowserOutput(!browserOutEnabled);
}

function ensureBrowserPlayerOption() {
    updateBrowserOutputUI();
}

window.isBrowserOutput = isBrowserOutput;
window.getBrowserNow = getBrowserNow;
window.setBrowserOutput = setBrowserOutput;
window.playBrowserQueue = playBrowserQueue;
window.browserPlayPath = browserPlayPath;
window.browserPlayAlbum = browserPlayAlbum;
window.browserAddPath = browserAddPath;
window.browserRadio = browserRadio;
window.browserTogglePlayPause = browserTogglePlayPause;
window.browserCmd = browserCmd;
window.toggleBrowserOutput = toggleBrowserOutput;
window.ensureBrowserPlayerOption = ensureBrowserPlayerOption;
window.updateBrowserOutputUI = updateBrowserOutputUI;
window.applyBrowserNowToUI = applyBrowserNowToUI;
window.BROWSER_PLAYER_KEY = BROWSER_PLAYER_KEY;
