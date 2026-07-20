/** DLNA MediaServer library browser (ContentDirectory). */

const DLNA_SERVER_KEY = "mpd-dlna-server";
const LIB_SOURCE_KEY = "mpd-library-source";

let dlnaServerSelected = {udn: "", location: "", name: ""};
let dlnaServersCache = [];
let dlnaBrowseStack = [{id: "0", title: "Root"}];
let dlnaCurrentObjectId = "0";
let librarySource = localStorage.getItem(LIB_SOURCE_KEY) || "mpd";

function isDlnaLibrary() {
    return librarySource === "dlna";
}

function loadDlnaServerPref() {
    try {
        const raw = localStorage.getItem(DLNA_SERVER_KEY);
        if (raw) dlnaServerSelected = JSON.parse(raw);
    } catch (e) {
        dlnaServerSelected = {udn: "", location: "", name: ""};
    }
}

function saveDlnaServerPref() {
    localStorage.setItem(DLNA_SERVER_KEY, JSON.stringify(dlnaServerSelected || {}));
}

function setLibrarySource(source) {
    librarySource = source === "dlna" ? "dlna" : "mpd";
    localStorage.setItem(LIB_SOURCE_KEY, librarySource);

    const sel = document.getElementById("librarySourceSelect");
    if (sel && sel.value !== librarySource) sel.value = librarySource;

    document.body.classList.toggle("library-dlna", isDlnaLibrary());
    document.body.classList.toggle("library-mpd", !isDlnaLibrary());

    syncLibrarySourceNav();

    if (isDlnaLibrary()) {
        if (typeof showView === "function") showView("library");
        dlnaBrowseStack = [{id: "0", title: "Root"}];
        dlnaCurrentObjectId = "0";
        refreshDlnaServerList().then(function() {
            dlnaBrowse("0");
        });
    } else if (typeof setLibMode === "function") {
        setLibMode(typeof libMode !== "undefined" ? libMode : "albums", true);
    }
}

function syncLibrarySourceNav() {
    document.querySelectorAll(".nav-mpd-only").forEach(function(el) {
        el.style.display = isDlnaLibrary() ? "none" : "";
    });
    document.querySelectorAll(".nav-dlna-only").forEach(function(el) {
        el.style.display = isDlnaLibrary() ? "" : "none";
    });

    const libModes = document.querySelector(".lib-modes");
    if (libModes) libModes.style.display = isDlnaLibrary() ? "none" : "";

    const folderControls = document.getElementById("folderControls");
    const dlnaControls = document.getElementById("dlnaServerControls");
    if (folderControls) folderControls.style.display = (!isDlnaLibrary() && typeof libMode !== "undefined" && libMode === "folders") ? "flex" : "none";
    if (dlnaControls) dlnaControls.style.display = isDlnaLibrary() ? "flex" : "none";

    const heading = document.getElementById("viewHeading");
    if (heading && isDlnaLibrary() && typeof activeView !== "undefined" && activeView.indexOf("library") === 0) {
        heading.innerText = "DLNA";
    }
}

async function refreshDlnaServerList() {
    try {
        const data = await dlnaServerList();
        dlnaServersCache = data.servers || [];
        fillDlnaServerSelect();
        return data;
    } catch (e) {
        fillDlnaServerSelect();
        throw e;
    }
}

function fillDlnaServerSelect() {
    const sel = document.getElementById("dlnaServerSelect");
    if (!sel) return;
    const prev = sel.value;
    clearElement(sel);

    const scanOpt = document.createElement("option");
    scanOpt.value = "__scan__";
    scanOpt.innerText = "— Scan servers —";
    sel.appendChild(scanOpt);

    const servers = dlnaServersCache.slice();
    if (dlnaServerSelected.location) {
        const inList = servers.some(function(s) {
            return s.location === dlnaServerSelected.location;
        });
        if (!inList) {
            servers.unshift({
                location: dlnaServerSelected.location,
                name: dlnaServerSelected.name || "DLNA server",
                udn: dlnaServerSelected.udn || ""
            });
        }
    }

    servers.forEach(function(s) {
        const opt = document.createElement("option");
        opt.value = s.location || "";
        opt.innerText = s.name || s.location || "DLNA server";
        opt.dataset.udn = s.udn || "";
        opt.dataset.name = s.name || "";
        sel.appendChild(opt);
    });

    if (dlnaServerSelected.location) {
        sel.value = dlnaServerSelected.location;
    } else if (servers.length) {
        sel.value = servers[0].location || "";
        selectDlnaServerFromOption(sel.options[sel.selectedIndex]);
    }
}

function selectDlnaServerFromOption(opt) {
    if (!opt || !opt.value || opt.value === "__scan__") return;
    dlnaServerSelected = {
        location: opt.value,
        udn: opt.dataset.udn || "",
        name: opt.dataset.name || opt.innerText || ""
    };
    saveDlnaServerPref();
}

function onDlnaServerSelectChange() {
    const sel = document.getElementById("dlnaServerSelect");
    if (!sel) return;
    if (sel.value === "__scan__") {
        scanDlnaServers();
        return;
    }
    selectDlnaServerFromOption(sel.options[sel.selectedIndex]);
    dlnaBrowseStack = [{id: "0", title: "Root"}];
    dlnaBrowse("0");
}

async function scanDlnaServers() {
    const box = document.getElementById("browser");
    if (box) {
        clearElement(box);
        box.appendChild(makeMeta("Scanning for DLNA servers…"));
    }
    try {
        const data = await dlnaServerScan(6);
        dlnaServersCache = data.servers || [];
        fillDlnaServerSelect();
        if (dlnaServersCache.length) {
            dlnaServerSelected = {
                location: dlnaServersCache[0].location || "",
                udn: dlnaServersCache[0].udn || "",
                name: dlnaServersCache[0].name || ""
            };
            saveDlnaServerPref();
            const sel = document.getElementById("dlnaServerSelect");
            if (sel) sel.value = dlnaServerSelected.location;
            dlnaBrowseStack = [{id: "0", title: "Root"}];
            dlnaBrowse("0");
        } else if (box) {
            clearElement(box);
            box.appendChild(makeMeta("No DLNA servers found on your network."));
        }
    } catch (e) {
        if (box) {
            clearElement(box);
            box.appendChild(makeMeta("Scan failed: " + (e.message || String(e))));
        }
    }
}

function updateDlnaPathLabel() {
    const el = document.getElementById("dlnaCurrentPath");
    if (!el) return;
    const parts = dlnaBrowseStack.map(function(s) { return s.title; });
    el.innerText = parts.join(" / ") || "Root";
}

async function dlnaBrowse(objectId) {
    if (!isDlnaLibrary()) return;
    dlnaCurrentObjectId = objectId || "0";
    updateDlnaPathLabel();

    const location = dlnaServerSelected.location || "";
    const box = document.getElementById("browser");
    if (!location) {
        if (box) {
            clearElement(box);
            box.appendChild(makeMeta("Select a DLNA server or scan the network."));
        }
        return;
    }

    if (box) {
        clearElement(box);
        box.appendChild(makeMeta("Loading…"));
    }

    try {
        const data = await dlnaServerBrowse(location, objectId);
        if (data.server_name && !dlnaServerSelected.name) {
            dlnaServerSelected.name = data.server_name;
            saveDlnaServerPref();
        }
        renderDlnaBrowseList(box, data.items || []);
    } catch (e) {
        if (box) {
            clearElement(box);
            box.appendChild(makeMeta("Browse error: " + (e.message || String(e))));
        }
    }
}

function renderDlnaBrowseList(box, items) {
    if (!box) return;
    clearElement(box);
    if (!items.length) {
        box.appendChild(makeMeta("Empty folder"));
        return;
    }

    const frag = document.createDocumentFragment();
    items.forEach(function(item) {
        const row = document.createElement("div");
        row.className = "item" + (item.type === "file" ? " playable-row" : "");

        const left = document.createElement("div");
        const name = document.createElement("div");
        name.className = "item-name";

        if (item.type === "directory") {
            name.className += " directory";
            name.innerText = "📁 " + (item.title || "Folder");
            name.onclick = function() {
                dlnaBrowseStack.push({id: item.id, title: item.title || "Folder"});
                dlnaBrowse(item.id);
            };
            left.appendChild(name);
        } else {
            left.appendChild(makeTrackLabel(item.title || "Track", item.url || item.id));
            bindPlayableRow(row, function() { playDlnaTrack(item); });
        }

        if (item.artist || item.album) {
            let metaText = "";
            if (item.artist) metaText += item.artist;
            if (item.album) metaText += (metaText ? " • " : "") + item.album;
            left.appendChild(makeMeta(metaText));
        }

        const actions = document.createElement("div");
        actions.className = "actions";

        if (item.type === "directory") {
            const playBtn = makeButton("▶", function() {
                playDlnaContainer(item.id);
            });
            playBtn.className = "pill accent play-folder-btn";
            playBtn.title = "Play all tracks in folder";
            actions.appendChild(playBtn);
        } else if (item.url) {
            actions.appendChild(makeButton("Cast", function() {
                castDlnaUrl(item);
            }));
        }

        row.appendChild(left);
        row.appendChild(actions);
        frag.appendChild(row);
    });
    box.appendChild(frag);
}

async function collectDlnaTracks(objectId, limit) {
    limit = limit || 200;
    const location = dlnaServerSelected.location || "";
    if (!location) return [];

    const tracks = [];
    let start = 0;
    const pageSize = 100;

    while (tracks.length < limit) {
        const data = await dlnaServerBrowse(location, objectId, start, pageSize);
        const items = data.items || [];
        if (!items.length) break;

        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (item.type === "file" && item.url) {
                tracks.push(item);
                if (tracks.length >= limit) return tracks;
            } else if (item.type === "directory") {
                const nested = await collectDlnaTracks(item.id, limit - tracks.length);
                tracks.push.apply(tracks, nested);
                if (tracks.length >= limit) return tracks;
            }
        }

        if (items.length < pageSize) break;
        start += items.length;
    }
    return tracks;
}

async function playDlnaContainer(objectId) {
    const box = document.getElementById("browser");
    const prev = box ? box.innerHTML : "";
    if (box) {
        clearElement(box);
        box.appendChild(makeMeta("Collecting tracks…"));
    }
    try {
        const tracks = await collectDlnaTracks(objectId, 300);
        if (!tracks.length) {
            if (typeof flashPlayerAction === "function") flashPlayerAction("No playable tracks in folder");
            dlnaBrowse(objectId);
            return;
        }
        await playDlnaQueue(tracks, 0);
    } catch (e) {
        alert(e.message || String(e));
        dlnaBrowse(objectId);
    }
}

async function playDlnaTrack(item) {
    if (!item || !item.url) {
        alert("No stream URL for this track");
        return;
    }
    await playDlnaQueue([item], 0);
}

async function playDlnaQueue(items, startIndex) {
    if (typeof isBrowserOutput === "function" && isBrowserOutput() &&
        typeof playBrowserQueue === "function") {
        const queue = (items || []).map(function(item) {
            return {
                url: item.url,
                title: item.title || "",
                artist: item.artist || "",
                album: item.album || ""
            };
        });
        await playBrowserQueue(queue, startIndex || 0);
        return;
    }

    if (typeof hasDlnaTarget === "function" && hasDlnaTarget()) {
        const item = items[startIndex || 0];
        await castDlnaUrl(item);
        return;
    }

    const item = items[startIndex || 0];
    try {
        await api("/api/playurl", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({url: item.url})
        });
        if (typeof refresh === "function") refresh();
        if (typeof loadQueue === "function") loadQueue();
    } catch (e) {
        alert(e.message || String(e));
    }
}

async function castDlnaUrl(item) {
    if (!item || !item.url) return;
    if (typeof hasAirplayTarget === "function" && hasAirplayTarget()) {
        if (typeof flashPlayerAction === "function") {
            flashPlayerAction("AirPlay needs local files — use DLNA cast or browser output");
        }
        return;
    }
    if (typeof hasDlnaTarget === "function" && !hasDlnaTarget()) {
        if (typeof showDlnaMsg === "function") showDlnaMsg("Select a DLNA cast device first");
        return;
    }
    try {
        await dlnaPlayUrl(item.url, {
            title: item.title || "",
            artist: item.artist || "",
            album: item.album || "",
            mime: item.mime || ""
        });
        if (typeof showDlnaMsg === "function") {
            showDlnaMsg("Casting “" + (item.title || "Track") + "”");
        }
    } catch (e) {
        if (typeof showDlnaMsg === "function") showDlnaMsg("Cast failed: " + (e.message || String(e)));
    }
}

function dlnaBrowseHome() {
    dlnaBrowseStack = [{id: "0", title: "Root"}];
    dlnaBrowse("0");
}

function dlnaBrowseUp() {
    if (dlnaBrowseStack.length <= 1) {
        dlnaBrowseHome();
        return;
    }
    dlnaBrowseStack.pop();
    const parent = dlnaBrowseStack[dlnaBrowseStack.length - 1];
    dlnaBrowse(parent.id);
}

function initDlnaLibrary() {
    loadDlnaServerPref();
    const sel = document.getElementById("librarySourceSelect");
    if (sel) sel.value = librarySource;
    document.body.classList.toggle("library-dlna", isDlnaLibrary());
    document.body.classList.toggle("library-mpd", !isDlnaLibrary());
    syncLibrarySourceNav();
    if (isDlnaLibrary()) {
        refreshDlnaServerList().catch(function() {});
    }
}

window.setLibrarySource = setLibrarySource;
window.onDlnaServerSelectChange = onDlnaServerSelectChange;
window.scanDlnaServers = scanDlnaServers;
window.dlnaBrowseHome = dlnaBrowseHome;
window.dlnaBrowseUp = dlnaBrowseUp;
window.dlnaBrowse = dlnaBrowse;
window.syncLibrarySourceNav = syncLibrarySourceNav;
window.isDlnaLibrary = isDlnaLibrary;
window.initDlnaLibrary = initDlnaLibrary;
window.playDlnaTrack = playDlnaTrack;
