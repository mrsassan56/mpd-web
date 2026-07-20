/** Unified desktop output selector: MPD (M), DLNA cast (D), AirPlay (A). */

const OUTPUT_MODE_KEY = "mpd-output-mode";
let _mpdPlayersCache = [];
let _mpdCurrentKey = "";
let _outputSelectBusy = false;
let _outputMode = localStorage.getItem(OUTPUT_MODE_KEY) || "mpd";
let _refreshSeq = 0;

function setOutputMode(mode) {
    _outputMode = mode || "mpd";
    try {
        localStorage.setItem(OUTPUT_MODE_KEY, _outputMode);
    } catch (e) {}
}

function getOutputMode() {
    return _outputMode;
}

function syncOutputModeFromTargets() {
    if (typeof isBrowserOutput === "function" && isBrowserOutput()) {
        setOutputMode("browser");
        return;
    }
    if (_outputMode === "airplay") {
        if (typeof hasAirplayTarget === "function" && !hasAirplayTarget()) {
            setOutputMode("mpd");
        }
        return;
    }
    if (_outputMode === "dlna") {
        if (typeof hasDlnaTarget === "function" && !hasDlnaTarget()) {
            setOutputMode("mpd");
        }
        return;
    }
    if (_outputMode === "browser") {
        return;
    }
    setOutputMode("mpd");
}

function encodeOutputValue(kind, id) {
    return kind + ":" + encodeURIComponent(id || "");
}

function parseOutputValue(val) {
    if (!val) return {kind: "", id: ""};
    const i = val.indexOf(":");
    if (i < 1) return {kind: "", id: ""};
    return {
        kind: val.slice(0, i),
        id: decodeURIComponent(val.slice(i + 1))
    };
}

function outputOptionLabel(kind, name) {
    const letter = kind === "mpd" ? "M" : kind === "dlna" ? "D" : kind === "airplay" ? "A" : "?";
    return letter + " · " + (name || "Output");
}

function getActiveOutputValue() {
    if (_outputMode === "browser") {
        const key = typeof BROWSER_PLAYER_KEY !== "undefined" ? BROWSER_PLAYER_KEY : "__browser__";
        return encodeOutputValue("mpd", key);
    }
    if (_outputMode === "airplay") {
        const id = airplaySelected.identifier || airplaySelected.address || "";
        if (id) return encodeOutputValue("airplay", id);
    }
    if (_outputMode === "dlna") {
        const id = dlnaSelected.location || dlnaSelected.udn || "";
        if (id) return encodeOutputValue("dlna", id);
    }
    if (typeof isBrowserOutput === "function" && isBrowserOutput()) {
        const key = typeof BROWSER_PLAYER_KEY !== "undefined" ? BROWSER_PLAYER_KEY : "__browser__";
        return encodeOutputValue("mpd", key);
    }
    if (typeof hasAirplayTarget === "function" && hasAirplayTarget()) {
        const id = airplaySelected.identifier || airplaySelected.address || "";
        if (id) return encodeOutputValue("airplay", id);
    }
    if (typeof hasDlnaTarget === "function" && hasDlnaTarget()) {
        const id = dlnaSelected.location || dlnaSelected.udn || "";
        if (id) return encodeOutputValue("dlna", id);
    }
    if (_mpdCurrentKey) {
        return encodeOutputValue("mpd", _mpdCurrentKey);
    }
    return "";
}

function appendOutputGroup(sel, label, options) {
    if (!options.length) return;
    const group = document.createElement("optgroup");
    group.label = label;
    options.forEach(function(opt) {
        group.appendChild(opt);
    });
    sel.appendChild(group);
}

function fillOutputSelect(playersData) {
    const sel = document.getElementById("outputSelect");
    if (!sel) return;

    if (playersData) {
        _mpdPlayersCache = playersData.players || [];
        if (playersData.current) _mpdCurrentKey = playersData.current;
        if (typeof isBrowserOutput === "function" && isBrowserOutput()) {
            const browserKey = typeof BROWSER_PLAYER_KEY !== "undefined" ? BROWSER_PLAYER_KEY : "__browser__";
            _mpdCurrentKey = browserKey;
        }
    }

    const active = getActiveOutputValue();
    clearElement(sel);

    const mpdOpts = [];
    const browserKey = typeof BROWSER_PLAYER_KEY !== "undefined" ? BROWSER_PLAYER_KEY : "__browser__";
    const browserOpt = document.createElement("option");
    browserOpt.value = encodeOutputValue("mpd", browserKey);
    browserOpt.innerText = outputOptionLabel("mpd", "This browser");
    mpdOpts.push(browserOpt);

    _mpdPlayersCache.forEach(function(p) {
        const opt = document.createElement("option");
        opt.value = encodeOutputValue("mpd", p.key);
        opt.innerText = outputOptionLabel("mpd", p.name || p.key);
        opt.dataset.mpdKey = p.key;
        mpdOpts.push(opt);
    });

    const dlnaOpts = [];
    const dlnaDevices = (typeof dlnaDevicesCache !== "undefined" ? dlnaDevicesCache : []).slice();
    if (typeof hasDlnaTarget === "function" && hasDlnaTarget()) {
        const inList = dlnaDevices.some(function(d) {
            return d.location === dlnaSelected.location || d.udn === dlnaSelected.udn;
        });
        if (!inList) {
            dlnaDevices.unshift({
                udn: dlnaSelected.udn || "",
                location: dlnaSelected.location || "",
                name: dlnaSelected.name || "DLNA device"
            });
        }
    }
    dlnaDevices.forEach(function(d) {
        const id = d.location || d.udn || "";
        if (!id) return;
        const opt = document.createElement("option");
        opt.value = encodeOutputValue("dlna", id);
        opt.innerText = outputOptionLabel("dlna", d.name || d.location || "DLNA");
        opt.dataset.udn = d.udn || "";
        opt.dataset.location = d.location || "";
        opt.dataset.name = d.name || "";
        dlnaOpts.push(opt);
    });

    const airOpts = [];
    const airDevices = (typeof airplayDevicesCache !== "undefined" ? airplayDevicesCache : []).slice();
    if (typeof hasAirplayTarget === "function" && hasAirplayTarget()) {
        const inList = airDevices.some(function(d) {
            return (d.identifier && d.identifier === airplaySelected.identifier) ||
                (d.address && d.address === airplaySelected.address);
        });
        if (!inList) {
            airDevices.unshift({
                identifier: airplaySelected.identifier || "",
                address: airplaySelected.address || "",
                name: airplaySelected.name || "AirPlay device"
            });
        }
    }
    airDevices.forEach(function(d) {
        const id = d.identifier || d.address || "";
        if (!id) return;
        const opt = document.createElement("option");
        opt.value = encodeOutputValue("airplay", id);
        opt.innerText = outputOptionLabel("airplay", d.name || d.address || "AirPlay");
        opt.dataset.identifier = d.identifier || "";
        opt.dataset.address = d.address || "";
        opt.dataset.name = d.name || "";
        airOpts.push(opt);
    });

    appendOutputGroup(sel, "MPD", mpdOpts);
    appendOutputGroup(sel, "DLNA cast", dlnaOpts);
    appendOutputGroup(sel, "AirPlay", airOpts);

    if (!mpdOpts.length && !dlnaOpts.length && !airOpts.length) {
        const empty = document.createElement("option");
        empty.value = "";
        empty.innerText = "No outputs — check Settings";
        sel.appendChild(empty);
    }

    if (active) {
        sel.value = active;
        if (sel.value !== active) {
            for (let i = 0; i < sel.options.length; i++) {
                if (sel.options[i].value === active) {
                    sel.selectedIndex = i;
                    break;
                }
            }
        }
    }
}

function syncOutputSelect() {
    if (_outputSelectBusy) return;
    fillOutputSelect(null);
}

async function clearRemoteCastOutputs() {
    if (typeof hasDlnaTarget === "function" && hasDlnaTarget()) {
        try {
            await dlnaSelect({udn: "", location: "", name: ""});
            dlnaSelected = {udn: "", location: "", name: ""};
        } catch (e) {}
    }
    if (typeof hasAirplayTarget === "function" && hasAirplayTarget()) {
        try {
            await airplaySelect({identifier: "", address: "", name: ""});
            airplaySelected = {identifier: "", address: "", name: "", has_credentials: false};
        } catch (e) {}
    }
    _castQueue = [];
    _castIndex = 0;
    _castNow = null;
}

async function onOutputSelectChange() {
    const sel = document.getElementById("outputSelect");
    if (!sel || _outputSelectBusy) return;

    const opt = sel.options[sel.selectedIndex];
    if (!opt || !opt.value) return;

    const parsed = parseOutputValue(opt.value);
    if (!parsed.kind) return;

    const prevMode = _outputMode;
    const browserKey = typeof BROWSER_PLAYER_KEY !== "undefined" ? BROWSER_PLAYER_KEY : "__browser__";
    if (parsed.kind === "mpd") {
        setOutputMode(parsed.id === browserKey ? "browser" : "mpd");
    } else {
        setOutputMode(parsed.kind);
    }
    if (parsed.kind === "airplay" || parsed.kind === "dlna") {
        if (typeof setBrowserOutput === "function") setBrowserOutput(false);
        applyCastOutputUI();
    }

    _outputSelectBusy = true;
    try {
        if (parsed.kind === "mpd") {
            await clearRemoteCastOutputs();

            if (parsed.id === browserKey) {
                if (typeof setBrowserOutput === "function") setBrowserOutput(true);
                _mpdCurrentKey = browserKey;
                if (typeof refresh === "function") refresh();
                if (typeof flashPlayerAction === "function") {
                    flashPlayerAction("Output → This browser");
                }
            } else {
                if (typeof isBrowserOutput === "function" && isBrowserOutput() &&
                    typeof setBrowserOutput === "function") {
                    setBrowserOutput(false);
                }
                await api("/api/player", {
                    method: "POST",
                    headers: {"Content-Type": "application/json"},
                    body: JSON.stringify({key: parsed.id})
                });
                _mpdCurrentKey = parsed.id;
                if (typeof lastCoverKey !== "undefined") lastCoverKey = "";
                if (typeof lastSongId !== "undefined") lastSongId = "";
                if (typeof clearLibListCache === "function") clearLibListCache();
                if (typeof refresh === "function") refresh();
                if (typeof loadQueue === "function") loadQueue();
                if (typeof loadPlaylists === "function") loadPlaylists();
                if (typeof flashPlayerAction === "function") {
                    flashPlayerAction("Output → " + (opt.innerText.replace(/^[MDA] · /, "") || parsed.id));
                }
            }
        } else if (parsed.kind === "dlna") {
            if (typeof isBrowserOutput === "function" && isBrowserOutput() &&
                typeof setBrowserOutput === "function") {
                setBrowserOutput(false);
            }
            if (typeof hasAirplayTarget === "function" && hasAirplayTarget()) {
                try {
                    await airplaySelect({identifier: "", address: "", name: ""});
                    airplaySelected = {identifier: "", address: "", name: "", has_credentials: false};
                } catch (e) {}
            }

            const baseEl = document.getElementById("dlnaPublicBase");
            const payload = {
                udn: opt.dataset.udn || "",
                location: opt.dataset.location || parsed.id,
                name: opt.dataset.name || opt.innerText.replace(/^[MDA] · /, "")
            };
            if (baseEl && baseEl.value.trim()) {
                payload.public_base = baseEl.value.trim();
            }
            const res = await dlnaSelect(payload);
            dlnaSelected = res.selected || payload;
            if (typeof rememberLocalDevice === "function") rememberLocalDevice(dlnaSelected);
            if (typeof flashPlayerAction === "function") {
                flashPlayerAction("Output → " + (dlnaSelected.name || "DLNA"));
            }
            applyCastOutputUI();
        } else if (parsed.kind === "airplay") {
            if (typeof isBrowserOutput === "function" && isBrowserOutput() &&
                typeof setBrowserOutput === "function") {
                setBrowserOutput(false);
            }
            if (typeof hasDlnaTarget === "function" && hasDlnaTarget()) {
                try {
                    await dlnaSelect({udn: "", location: "", name: ""});
                    dlnaSelected = {udn: "", location: "", name: ""};
                } catch (e) {}
            }

            const payload = {
                identifier: opt.dataset.identifier || parsed.id,
                address: opt.dataset.address || "",
                name: opt.dataset.name || opt.innerText.replace(/^[MDA] · /, "")
            };
            const res = await airplaySelect(payload);
            airplaySelected = res.selected || payload;
            if (typeof rememberLocalAirplayDevice === "function") {
                rememberLocalAirplayDevice(airplaySelected);
            }
            if (typeof flashPlayerAction === "function") {
                flashPlayerAction("Output → " + (airplaySelected.name || "AirPlay"));
            }
            applyCastOutputUI();
        }
    } catch (e) {
        setOutputMode(prevMode);
        if (typeof flashPlayerAction === "function") {
            flashPlayerAction("Output failed: " + (e.message || String(e)));
        } else {
            alert(e.message || String(e));
        }
        syncOutputSelect();
    } finally {
        _outputSelectBusy = false;
        if (typeof syncDlnaUi === "function") syncDlnaUi();
        if (typeof syncAirplayUi === "function") syncAirplayUi();
        syncOutputSelect();
    }
}

window.fillOutputSelect = fillOutputSelect;
window.syncOutputSelect = syncOutputSelect;
window.onOutputSelectChange = onOutputSelectChange;

let _castQueue = [];
let _castIndex = 0;
let _castNow = null;

function isAirplayOutput() {
    return _outputMode === "airplay";
}

function isDlnaCastOutput() {
    return _outputMode === "dlna";
}

function isRemoteCastOutput() {
    return _outputMode === "airplay" || _outputMode === "dlna";
}

function usesMpdTransport() {
    return _outputMode === "mpd";
}

function applyCastOutputUI() {
    if (_castNow && (_castNow.file || _castNow.url)) {
        updateCastNowPlayingUI(_castNow.file || _castNow.url, _castNow);
        return;
    }

    let dest = "Cast";
    if (_outputMode === "airplay" && typeof airplayTargetLabel === "function") {
        dest = airplayTargetLabel();
    } else if (_outputMode === "dlna" && typeof dlnaTargetLabel === "function") {
        dest = dlnaTargetLabel();
    }

    const titleEl = document.getElementById("title");
    const artistEl = document.getElementById("artist");
    const albumEl = document.getElementById("album");
    const heroTitle = document.getElementById("heroTitle");
    const heroArtist = document.getElementById("heroArtist");
    const heroAlbum = document.getElementById("heroAlbum");
    const statusEl = document.getElementById("status");

    if (titleEl) titleEl.innerText = "—";
    if (artistEl) artistEl.innerText = dest;
    if (albumEl) albumEl.innerText = "Pick a track to play";
    if (heroTitle) heroTitle.innerText = "—";
    if (heroArtist) heroArtist.innerText = dest;
    if (heroAlbum) heroAlbum.innerText = "";
    if (statusEl) statusEl.innerText = "ready  ·  " + dest;

    if (typeof syncGotoAlbumButtons === "function") syncGotoAlbumButtons(false);
    if (typeof updatePlayPauseButton === "function") updatePlayPauseButton("pause");
}

function bumpRefreshSeq() {
    return ++_refreshSeq;
}

function isRefreshStale(seq) {
    return seq !== _refreshSeq || !usesMpdTransport();
}

async function initOutputRouting() {
    try {
        if (typeof refreshDlnaState === "function") await refreshDlnaState();
    } catch (e) {}
    try {
        if (typeof refreshAirplayState === "function") await refreshAirplayState();
    } catch (e) {}
    syncOutputModeFromTargets();
    fillOutputSelect(null);
    if (isRemoteCastOutput()) applyCastOutputUI();
}

function initOutputMode() {
    const saved = localStorage.getItem(OUTPUT_MODE_KEY);
    if (saved) _outputMode = saved;
    syncOutputModeFromTargets();
    if (isRemoteCastOutput()) applyCastOutputUI();
}

function shortNameFromCastPath(path) {
    if (!path) return "";
    const parts = path.split("/");
    return parts[parts.length - 1] || path;
}

function updateCastNowPlayingUI(file, meta) {
    meta = meta || {};
    const url = meta.url || "";
    const title = meta.title || shortNameFromCastPath(file || url);
    const artist = meta.artist || "";
    const album = meta.album || "";
    _castNow = {file: file || url, url: url, title: title, artist: artist, album: album};

    if (typeof setDlnaCurrentFile === "function") setDlnaCurrentFile(file);

    const titleEl = document.getElementById("title");
    const artistEl = document.getElementById("artist");
    const albumEl = document.getElementById("album");
    if (titleEl) titleEl.innerText = title;
    if (artistEl) artistEl.innerText = artist;
    if (albumEl) albumEl.innerText = album;

    const heroTitle = document.getElementById("heroTitle");
    const heroArtist = document.getElementById("heroArtist");
    const heroAlbum = document.getElementById("heroAlbum");
    if (heroTitle) heroTitle.innerText = title;
    if (heroArtist) heroArtist.innerText = artist;
    if (heroAlbum) heroAlbum.innerText = album;

    if (typeof currentSongMeta !== "undefined") {
        currentSongMeta = {
            album: album,
            albumartist: meta.albumartist || "",
            artist: artist
        };
    }

    const coverUrl = file ? "/api/cover?disk=1&file=" + encodeURIComponent(file) : "";
    const cover = document.getElementById("coverArt");
    const heroCover = document.getElementById("heroCover");
    const heroPlaceholder = document.getElementById("heroPlaceholder");
    if (file && cover) {
        cover.style.display = "block";
        cover.src = coverUrl;
        cover.onerror = function() { cover.style.display = "none"; };
    }
    if (file && heroCover) {
        heroCover.style.display = "block";
        heroCover.src = coverUrl;
        heroCover.onerror = function() {
            heroCover.style.display = "none";
            if (heroPlaceholder) heroPlaceholder.style.display = "flex";
        };
        if (heroPlaceholder) heroPlaceholder.style.display = "none";
    }

    if (typeof updatePlayPauseButton === "function") updatePlayPauseButton("play");

    const statusEl = document.getElementById("status");
    if (statusEl) {
        const dest = isAirplayOutput() ?
            (typeof airplayTargetLabel === "function" ? airplayTargetLabel() : "AirPlay") :
            (typeof dlnaTargetLabel === "function" ? dlnaTargetLabel() : "DLNA");
        statusEl.innerText = "play  ·  " + dest;
    }
}

async function resolvePathTracks(path) {
    let tracks = [];
    try {
        const data = await api("/api/foldertracks?path=" + encodeURIComponent(path) + "&limit=500");
        tracks = (data.tracks || []).map(function(t) {
            return {
                file: t.file || t.path || "",
                title: t.title || "",
                artist: t.artist || "",
                album: t.album || ""
            };
        }).filter(function(t) { return !!t.file; });
    } catch (e) {}

    if (!tracks.length) {
        try {
            const data = await api("/api/browse?path=" + encodeURIComponent(path));
            if (Array.isArray(data) && data.length) {
                tracks = data.filter(function(i) { return i.type === "file" && i.path; }).map(function(i) {
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

    if (!tracks.length && path) {
        tracks = [{file: path, title: "", artist: "", album: ""}];
    }
    return tracks;
}

async function castOutputPlayTrack(track) {
    const file = track.file || track.path || "";
    const url = track.url || "";
    const meta = {
        title: track.title || "",
        artist: track.artist || "",
        album: track.album || "",
        mime: track.mime || "",
        url: url
    };
    if (!file && !url) throw new Error("No file to play");

    if (isAirplayOutput() && typeof hasAirplayTarget === "function" && hasAirplayTarget()) {
        const res = await airplayPlay(url ? "" : file, meta);
        updateCastNowPlayingUI(file || url, meta);
        if (typeof flashPlayerAction === "function") {
            flashPlayerAction("AirPlay → " + (typeof airplayTargetLabel === "function" ? airplayTargetLabel() : ""));
        }
        return res;
    }
    if (isDlnaCastOutput() && typeof hasDlnaTarget === "function" && hasDlnaTarget()) {
        if (url) {
            await dlnaPlayUrl(url, meta);
        } else {
            await dlnaPlay(file, meta);
        }
        updateCastNowPlayingUI(file || url, meta);
        if (typeof flashPlayerAction === "function") {
            flashPlayerAction("DLNA → " + (typeof dlnaTargetLabel === "function" ? dlnaTargetLabel() : ""));
        }
        return;
    }
    throw new Error("No cast output selected");
}

async function castOutputPlayPath(path) {
    if (!path) return;
    const tracks = await resolvePathTracks(path);
    if (!tracks.length) {
        alert("Nothing to play");
        return;
    }
    _castQueue = tracks;
    _castIndex = 0;
    await castOutputPlayTrack(tracks[0]);
}

async function castOutputPlayAlbum(al) {
    const q = new URLSearchParams({
        album: al.album || "",
        albumartist: al.albumartist || ""
    });
    const tracks = await api("/api/albumtracks?" + q.toString());
    const list = (tracks || []).filter(function(t) { return t.file; });
    if (!list.length) {
        alert("No tracks in album");
        return;
    }
    _castQueue = list.map(function(t) {
        return {
            file: t.file,
            title: t.title || "",
            artist: t.artist || "",
            album: al.album || ""
        };
    });
    _castIndex = 0;
    await castOutputPlayTrack(_castQueue[0]);
}

async function castOutputCmd(name) {
    if (name === "next" && _castQueue.length > 1) {
        _castIndex = (_castIndex + 1) % _castQueue.length;
        await castOutputPlayTrack(_castQueue[_castIndex]);
        return true;
    }
    if (name === "previous" && _castQueue.length > 1) {
        _castIndex = (_castIndex - 1 + _castQueue.length) % _castQueue.length;
        await castOutputPlayTrack(_castQueue[_castIndex]);
        return true;
    }
    if (name === "stop") {
        if (isAirplayOutput()) {
            await airplayCmd("stop");
        } else if (isDlnaCastOutput()) {
            await dlnaCmd("stop");
        }
        _castNow = null;
        if (typeof updatePlayPauseButton === "function") updatePlayPauseButton("pause");
        if (typeof applyCastOutputUI === "function") applyCastOutputUI();
        return true;
    }
    if (name === "pause" && isDlnaCastOutput()) {
        await dlnaCmd("pause");
        if (typeof updatePlayPauseButton === "function") updatePlayPauseButton("pause");
        return true;
    }
    if (name === "play" && isDlnaCastOutput()) {
        await dlnaCmd("play");
        if (typeof updatePlayPauseButton === "function") updatePlayPauseButton("play");
        return true;
    }
    return false;
}

async function castOutputTogglePlayPause() {
    if (typeof playbackState !== "undefined" && playbackState === "play") {
        if (isAirplayOutput()) {
            await airplayCmd("stop");
            if (typeof updatePlayPauseButton === "function") updatePlayPauseButton("pause");
            return;
        }
        if (isDlnaCastOutput()) {
            await dlnaCmd("pause");
            if (typeof updatePlayPauseButton === "function") updatePlayPauseButton("pause");
            return;
        }
    }
    if (_castNow && (_castNow.file || _castNow.url)) {
        await castOutputPlayTrack(_castNow);
        return;
    }
    if (typeof flashPlayerAction === "function") {
        flashPlayerAction("Pick a track to play");
    }
}

window.isRemoteCastOutput = isRemoteCastOutput;
window.isAirplayOutput = isAirplayOutput;
window.isDlnaCastOutput = isDlnaCastOutput;
window.usesMpdTransport = usesMpdTransport;
window.getOutputMode = getOutputMode;
window.applyCastOutputUI = applyCastOutputUI;
window.bumpRefreshSeq = bumpRefreshSeq;
window.isRefreshStale = isRefreshStale;
window.initOutputRouting = initOutputRouting;
window.initOutputMode = initOutputMode;
window.castOutputPlayPath = castOutputPlayPath;
window.castOutputPlayAlbum = castOutputPlayAlbum;
window.castOutputCmd = castOutputCmd;
window.castOutputTogglePlayPause = castOutputTogglePlayPause;
