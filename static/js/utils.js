function clearElement(el) {
    while (el.firstChild) {
        el.removeChild(el.firstChild);
    }
}

function makeMeta(text) {
    const div = document.createElement("div");
    div.className = "meta";
    div.innerText = text || "";
    return div;
}

function makeButton(text, fn) {
    const btn = document.createElement("button");
    btn.innerText = text;
    btn.onclick = fn;
    return btn;
}

function folderFromFilePath(filePath) {
    if (!filePath) return "";
    const parts = filePath.split("/");
    if (parts.length <= 1) return "/";
    parts.pop();
    return parts.join("/") || "/";
}

function shortFileName(path) {
    if (!path) return "";
    const parts = path.split("/");
    return parts[parts.length - 1] || path;
}

function shortFolderName(path) {
    if (!path) return "";
    const parts = path.split("/");
    if (parts.length > 1) {
        parts.pop();
        return parts.join("/");
    }
    return path;
}

/** Strip Discogs-style release IDs and other long digit tags from display names. */
function cleanReleaseDisplayName(name) {
    if (!name) return "";
    let s = String(name);
    s = s.replace(/[\(\[]\s*\d{5,}\s*[\)\]]/g, "");
    s = s.replace(/\[\s*\]|\(\s*\)/g, "");
    s = s.replace(/\s{2,}/g, " ").trim();
    s = s.replace(/^[\-\u2013\u2014\s]+|[\-\u2013\u2014\s]+$/g, "").trim();
    return s || name;
}

function debounce(fn, ms) {
    let timer;
    return function() {
        const args = arguments;
        const self = this;
        clearTimeout(timer);
        timer = setTimeout(function() { fn.apply(self, args); }, ms);
    };
}

function formatDuration(secs) {
    secs = Math.floor(secs || 0);
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return m + ":" + String(s).padStart(2, "0");
}

function bindPlayableRow(row, playFn) {
    if (!row || typeof playFn !== "function") return;
    row.classList.add("playable-row");
    row.onclick = function(ev) {
        if (ev.target.closest(".actions, button, select, a, input, label")) return;
        playFn();
    };
}

function updateLibFilterPlaceholder(mode) {
    const input = document.getElementById("libFilter");
    if (!input) return;
    if (mode === "albums") input.placeholder = "Search all albums…";
    else if (mode === "artists") input.placeholder = "Search all artists…";
    else if (mode === "folders") input.placeholder = "Filter in this folder…";
    else input.placeholder = "Filter this list…";
}

function clearLibFilter() {
    const input = document.getElementById("libFilter");
    if (input) input.value = "";
}

function getLibFilterQuery() {
    const input = document.getElementById("libFilter");
    return input ? input.value.trim() : "";
}

function onLibFilterInput() {
    const mode = typeof libMode !== "undefined" ? libMode : "";
    if (mode === "albums" || mode === "artists") {
        debouncedLibSearch();
        return;
    }
    applyLibFilter();
}

function applyLibFilter() {
    const input = document.getElementById("libFilter");
    const box = document.getElementById("browser");
    if (!input || !box) return;

    const mode = typeof libMode !== "undefined" ? libMode : "";
    if (mode === "albums" || mode === "artists") {
        return;
    }

    const q = input.value.trim().toLowerCase();
    let visible = 0;
    const rows = box.querySelectorAll(".item, .album-card");
    rows.forEach(function(row) {
        const text = (row.innerText || "").toLowerCase();
        const show = !q || text.indexOf(q) >= 0;
        row.style.display = show ? "" : "none";
        if (show) visible += 1;
    });

    let empty = box.querySelector(".lib-filter-empty");
    if (q && visible === 0) {
        if (!empty) {
            empty = document.createElement("div");
            empty.className = "meta lib-filter-empty";
            box.appendChild(empty);
        }
        empty.innerText = "No matches for \"" + input.value.trim() + "\"";
        empty.style.display = "";
    } else if (empty) {
        empty.style.display = "none";
    }
}

const debouncedLibSearch = debounce(function() {
    if (typeof libMode === "undefined") return;
    if (libMode === "artists" && typeof loadArtists === "function") {
        loadArtists(false);
    } else if (libMode === "albums" && typeof loadAlbums === "function") {
        const artist = typeof currentArtist !== "undefined" ? currentArtist : "";
        loadAlbums(artist || "", false);
    }
}, 280);

const LIB_LIST_CACHE = {};
const LIB_LIST_CACHE_TTL = 120000;

function libListCacheKey(kind, key) {
    return kind + "|" + (key == null ? "" : String(key));
}

function getLibListCache(kind, key) {
    const entry = LIB_LIST_CACHE[libListCacheKey(kind, key)];
    if (!entry) return null;
    if (Date.now() - entry.t > LIB_LIST_CACHE_TTL) {
        delete LIB_LIST_CACHE[libListCacheKey(kind, key)];
        return null;
    }
    return entry.data;
}

function setLibListCache(kind, key, data) {
    LIB_LIST_CACHE[libListCacheKey(kind, key)] = {t: Date.now(), data: data};
}

function clearLibListCache() {
    Object.keys(LIB_LIST_CACHE).forEach(function(k) {
        delete LIB_LIST_CACHE[k];
    });
}

function classifyTrackQuality(file) {
    if (!file) return "normal";
    if (/\.(dsf|dff)$/i.test(file) || /\/DSD(?:\/|$)/i.test(file) || /\bDSD\d+/i.test(file)) {
        return "dsd";
    }
    const tag = file.match(/\[(\d+)B-([\d.]+)kHz\]/i);
    if (tag) {
        const bits = parseInt(tag[1], 10);
        const khz = parseFloat(tag[2]);
        if (bits >= 24 || khz >= 48) return "hires";
    }
    return "normal";
}

function makeTrackLabel(title, file, className) {
    const wrap = document.createElement("div");
    wrap.className = className || "item-name file track-label";

    const tier = classifyTrackQuality(file);
    if (tier === "dsd" || tier === "hires") {
        const dot = document.createElement("span");
        dot.className = "track-quality track-quality-" + tier;
        dot.title = tier === "dsd" ? "DSD" : "Hi-res";
        dot.setAttribute("aria-label", dot.title);
        wrap.appendChild(dot);
    }

    const text = document.createElement("span");
    text.className = "track-label-text";
    text.innerText = title || "";
    wrap.appendChild(text);
    return wrap;
}

function formatAudioInfo(song, status) {
    const file = (song && song.file) || "";
    if (!file) return "";

    const chunks = [];
    const ext = (file.match(/\.([^.]+)$/i) || [])[1];

    if (/\.(dsf|dff)$/i.test(file) || /\/DSD(?:\/|$)/i.test(file)) {
        chunks.push("DSD");
    } else if (ext) {
        chunks.push(ext.toUpperCase());
    }

    const pathTag = file.match(/\[(\d+)B-([\d.]+)kHz\]/i);
    if (pathTag) {
        chunks.push(pathTag[1] + "-bit");
        chunks.push(pathTag[2] + " kHz");
        return chunks.join(" · ");
    }

    const dsdRate = file.match(/DSD(\d+)/i);
    if (dsdRate) {
        chunks.push("DSD" + dsdRate[1]);
        return chunks.join(" · ");
    }

    const audio = (status && status.audio) || (song && song.audio) || "";
    if (audio) {
        const parts = String(audio).split(":");
        const rate = parseInt(parts[0], 10);
        const bits = parseInt(parts[1], 10);
        if (bits > 0 && bits <= 32) {
            chunks.push(bits + "-bit");
        }
        if (rate >= 8000) {
            const khz = rate / 1000;
            chunks.push((khz % 1 === 0 ? khz.toFixed(0) : khz.toFixed(1)) + " kHz");
        }
        if (chunks.length > 1) {
            return chunks.join(" · ");
        }
    }

    const bitrate = status && status.bitrate ? parseInt(status.bitrate, 10) : 0;
    if (bitrate > 0) {
        chunks.push(Math.round(bitrate / 1000) + " kbps");
    }

    return chunks.join(" · ");
}

let playbackState = "stop";

function updatePlayPauseButton(state) {
    playbackState = state || "stop";
    const btn = document.getElementById("playPauseBtn");
    if (!btn) return;
    if (playbackState === "play") {
        btn.innerText = "❚❚";
        btn.title = "Pause";
        btn.classList.add("is-playing");
    } else {
        btn.innerText = "▶︎";
        btn.title = "Play";
        btn.classList.remove("is-playing");
    }
}

async function togglePlayPause() {
    try {
        if (typeof isBrowserOutput === "function" && isBrowserOutput()) {
            await browserTogglePlayPause();
            return;
        }
        if (playbackState === "play") {
            await api("/api/pause", {method: "POST"});
        } else {
            await api("/api/play", {method: "POST"});
        }
        if (typeof refresh === "function") refresh();
    } catch (e) {
        alert(e.message || String(e));
    }
}

function warmCoverCache(opts) {
    opts = opts || {};
    // Prefetch folder covers from disk only — never trigger MPD albumart.
    const files = (opts.files || []).filter(Boolean).slice(0, 20);
    files.forEach(function(fp) {
        const img = new Image();
        img.decoding = "async";
        img.src = "/api/cover?disk=1&file=" + encodeURIComponent(fp);
    });
    if (!files.length) return;
    api("/api/cover/warm", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({files: files})
    }).catch(function() {});
}
