let currentPath = "";
let lastSongId = "";
let lastCoverKey = "";
let libMode = "folders";
let currentArtist = "";
let searchMode = "tracks";
let currentSongMeta = {album: "", albumartist: "", artist: ""};
const LIB_PAGE_SIZE = 20;
let libPage = {kind: "", key: "", offset: 0, total: 0, items: []};
let searchPage = {q: "", mode: "", offset: 0, total: 0, items: []};
let searchSeq = 0;

function showTab(tab, skipBrowseLoad) {
    document.querySelectorAll(".panel").forEach(function(p) {
        p.classList.remove("active");
    });
    document.getElementById("panel-" + tab).classList.add("active");
    document.querySelectorAll("#tabbar button").forEach(function(b) {
        b.classList.toggle("active", b.getAttribute("data-tab") === tab);
    });
    if (tab === "queue") loadQueue();
    if (tab === "lists") loadPlaylists();
    if (tab === "recent") loadRecentPlays();
        if (tab === "settings") {
        loadPlayers();
        if (typeof loadDlnaSettingsPanel === "function") loadDlnaSettingsPanel();
        if (typeof loadPlaybackSettings === "function") loadPlaybackSettings();
    }
    if (tab === "browse" && !skipBrowseLoad) setLibMode(libMode, true);
}

async function refresh() {
    try {
        if (typeof isBrowserOutput === "function" && isBrowserOutput()) {
            if (typeof applyBrowserNowToUI === "function") applyBrowserNowToUI();
            return;
        }
        const data = await api("/api/status");
        const song = data.song || {};
        const status = data.status || {};
        const songId = status.songid || "";

        if (lastSongId && songId && songId !== lastSongId) {
            loadQueue();
        }
        lastSongId = songId;

        document.getElementById("title").innerText = song.title || song.file || "No song";
        document.getElementById("artist").innerText = song.artist || "";
        document.getElementById("album").innerText = song.album || "";
        currentSongMeta = {
            album: song.album || "",
            albumartist: song.albumartist || "",
            artist: song.artist || ""
        };
        const gotoBtn = document.getElementById("nowGotoAlbum");
        if (gotoBtn) gotoBtn.style.display = currentSongMeta.album ? "inline-flex" : "none";
        const audioInfo = formatAudioInfo(song, status);
        const formatEl = document.getElementById("audioFormat");
        if (formatEl) {
            formatEl.innerText = audioInfo;
            formatEl.style.display = audioInfo ? "inline-block" : "none";
        }
        const randomBtn = document.getElementById("randomBtn");
        if (randomBtn) randomBtn.classList.toggle("active", status.random === "1");
        const randomState = document.getElementById("randomState");
        if (randomState) randomState.innerText = status.random === "1" ? "On" : "Off";

        const elapsed = Math.floor(status.elapsed || 0);
        const duration = Math.floor(status.duration || 0);
        document.getElementById("status").innerText =
            (status.state || "-") + " · " + elapsed + "/" + duration;

        updatePlayPauseButton(status.state);
        if (typeof updateSleepTimerUI === "function") {
            updateSleepTimerUI(data.sleep_timer);
        }

        const cover = document.getElementById("coverArt");
        const coverKey = (song.file || "") + "|" + songId;
        if (!mobileCoversEnabled()) {
            if (cover) {
                cover.classList.add("hidden");
                cover.removeAttribute("src");
            }
            lastCoverKey = "";
        } else if (song.file && coverKey !== lastCoverKey) {
            lastCoverKey = coverKey;
            cover.classList.remove("hidden");
            cover.src = "/api/cover?file=" + encodeURIComponent(song.file) +
                "&id=" + encodeURIComponent(songId || "");
            cover.onerror = function() { cover.classList.add("hidden"); };
        }
        if (!song.file) {
            cover.classList.add("hidden");
            lastCoverKey = "";
            currentSongMeta = {album: "", albumartist: "", artist: ""};
            const gotoClear = document.getElementById("nowGotoAlbum");
            if (gotoClear) gotoClear.style.display = "none";
        }
        setCurrentTrack(song);
    } catch (e) {
        document.getElementById("title").innerText = "Cannot connect";
        document.getElementById("artist").innerText = e.message || String(e);
        const gotoErr = document.getElementById("nowGotoAlbum");
        if (gotoErr) gotoErr.style.display = "none";
    }
}

function goToPlayingAlbum() {
    if (!currentSongMeta.album) return;
    setLibMode("albums", true, true);
    showTab("browse", true);
    openAlbum({
        album: currentSongMeta.album,
        albumartist: currentSongMeta.albumartist || currentSongMeta.artist || ""
    });
}

async function cmd(name) {
    if (typeof isBrowserOutput === "function" && isBrowserOutput() &&
        (name === "next" || name === "previous" || name === "stop")) {
        await browserCmd(name);
        if (name === "next" || name === "previous" || name === "stop") loadQueue();
        return;
    }
    await api("/api/" + name, {method: "POST"});
    refresh();
    if (name === "next" || name === "previous" || name === "stop") loadQueue();
}

async function toggleRandom() {
    await api("/api/random", {method: "POST"});
    refresh();
}

async function loadPlayers() {
    try {
        const data = await api("/api/players");
        const sel = document.getElementById("playerSelect");
        clearElement(sel);
        if (typeof ensureBrowserPlayerOption === "function") {
            /* option added below after clear */
        }
        const browserOpt = document.createElement("option");
        browserOpt.value = (typeof BROWSER_PLAYER_KEY !== "undefined" ? BROWSER_PLAYER_KEY : "__browser__");
        browserOpt.innerText = "This browser";
        sel.appendChild(browserOpt);
        (data.players || []).forEach(function(p) {
            const opt = document.createElement("option");
            opt.value = p.key;
            opt.innerText = p.name;
            sel.appendChild(opt);
        });
        if (typeof isBrowserOutput === "function" && isBrowserOutput()) {
            sel.value = browserOpt.value;
        } else if (data.current) {
            sel.value = data.current;
        }
        if (typeof updateBrowserOutputUI === "function") updateBrowserOutputUI();
    } catch (e) {}
}

async function changePlayer() {
    const key = document.getElementById("playerSelect").value;
    if (typeof BROWSER_PLAYER_KEY !== "undefined" && key === BROWSER_PLAYER_KEY) {
        if (typeof setBrowserOutput === "function") setBrowserOutput(true);
        if (typeof refresh === "function") refresh();
        return;
    }
    if (typeof isBrowserOutput === "function" && isBrowserOutput()) {
        setBrowserOutput(false);
    }
    await api("/api/player", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({key: key})
    });
    lastCoverKey = "";
    lastSongId = "";
    clearLibListCache();
    refresh();
    loadQueue();
    refreshPlaylistNames();
}

function setSearchMode(mode) {
    searchMode = mode;
    document.querySelectorAll("#searchChips button").forEach(function(btn) {
        btn.classList.toggle("active", btn.getAttribute("data-mode") === mode);
    });
    searchMusic();
}

async function searchMusic(append) {
    append = append === true;
    const q = document.getElementById("searchBox").value.trim();
    const box = document.getElementById("searchResults");
    const seq = append ? searchSeq : ++searchSeq;
    if (!append) {
        clearElement(box);
        searchPage = {q: q, mode: searchMode, offset: 0, total: 0, items: []};
    }
    if (!q) return;

    try {
        const data = await apiSearch({
            q: q,
            type: "any",
            mode: searchMode,
            limit: 20,
            offset: searchPage.offset
        });
        if (seq !== searchSeq) return;
        const results = data.results || [];
        searchPage.total = data.total || 0;
        searchPage.items = append ? searchPage.items.concat(results) : results;
        searchPage.offset = searchPage.items.length;

        clearElement(box);
        if (!searchPage.items.length) {
            box.appendChild(makeMeta("No results."));
            return;
        }
        if (searchPage.total > searchPage.items.length) {
            box.appendChild(makeMeta("Showing " + searchPage.items.length + " of " + searchPage.total));
        }

        if (searchMode === "albums") {
            searchPage.items.forEach(function(al) {
                box.appendChild(makeItemRow(
                    "💿 " + al.album,
                    (al.albumartist || "") + " · " + al.track_count,
                    [],
                    function() {
                        setLibMode("albums", true, true);
                        showTab("browse", true);
                        openAlbum({album: al.album, albumartist: al.albumartist || ""});
                    }
                ));
            });
        } else if (searchMode === "artists") {
            searchPage.items.forEach(function(ar) {
                box.appendChild(makeItemRow(
                    "🎤 " + ar.artist,
                    ar.track_count + " tracks",
                    [],
                    function() {
                        openArtist(ar.artist);
                        showTab("browse");
                    }
                ));
            });
        } else {
            searchPage.items.forEach(function(item) {
                const actions = [];
                if (item.album) {
                    const goAlbum = makeBtn("→", function() {
                        setLibMode("albums", true, true);
                        showTab("browse", true);
                        openAlbum({
                            album: item.album,
                            albumartist: item.albumartist || item.artist || ""
                        });
                    });
                    goAlbum.className = "pill accent search-goto-album";
                    goAlbum.title = "Go to album";
                    actions.push(goAlbum);
                }
                actions.push(makeBtn("Add", function() { addPath(item.file); }));
                if (typeof makeCastButton === "function") {
                    actions.push(makeCastButton(item.file, {
                        title: item.title || "",
                        artist: item.artist || "",
                        album: item.album || ""
                    }));
                }
                const sel = makePlaylistSelect(async function(name) {
                    await addFileToPlaylist(name, item.file);
                });
                sel.className = "playlist-select";
                actions.push(sel);

                const row = document.createElement("div");
                row.className = "item";
                bindPlayableRow(row, function() { playPath(item.file); });
                const main = document.createElement("div");
                main.className = "row-main";
                const img = document.createElement("img");
                img.className = "thumb";
                img.loading = "lazy";
                img.src = "/api/albumcover?album=" + encodeURIComponent(item.album || "") +
                    "&albumartist=" + encodeURIComponent(item.albumartist || item.artist || "");
                img.onerror = function() { img.classList.add("hidden"); };
                main.appendChild(img);
                const text = document.createElement("div");
                text.appendChild(makeTrackLabel(
                    item.title || shortFileName(item.file),
                    item.file
                ));
                text.appendChild(elText("item-sub", [item.artist, item.album].filter(Boolean).join(" · ")));
                main.appendChild(text);
                row.appendChild(main);
                const act = document.createElement("div");
                act.className = "actions";
                actions.forEach(function(a) { act.appendChild(a); });
                row.appendChild(act);
                box.appendChild(row);
            });
        }

        if (searchPage.items.length < searchPage.total) {
            const more = makeBtn("Show more", function() { searchMusic(true); });
            more.className = "pill accent";
            box.appendChild(more);
        }
    } catch (e) {
        if (seq !== searchSeq) return;
        if (!append) {
            clearElement(box);
            box.appendChild(makeMeta("Error: " + (e.message || String(e))));
        }
    }
}

function elText(cls, text) {
    const d = document.createElement("div");
    d.className = cls;
    d.innerText = text;
    return d;
}

function makeBtn(label, fn) {
    const b = document.createElement("button");
    b.innerText = label;
    b.onclick = fn;
    return b;
}

function makeItemRow(title, sub, buttons, onRowClick, trackFile, extraClass) {
    const row = document.createElement("div");
    row.className = "item" + (extraClass ? (" " + extraClass) : "");
    const left = document.createElement("div");
    left.className = "row-main";
    const text = document.createElement("div");
    text.className = "row-text";
    if (trackFile) {
        text.appendChild(makeTrackLabel(title, trackFile));
    } else {
        text.appendChild(elText("item-name", title));
    }
    if (sub) text.appendChild(elText("item-sub", sub));
    left.appendChild(text);
    row.appendChild(left);
    if (buttons && buttons.length) {
        const act = document.createElement("div");
        act.className = "actions";
        buttons.forEach(function(b) { act.appendChild(b); });
        row.appendChild(act);
    }
    if (onRowClick) bindPlayableRow(row, onRowClick);
    return row;
}

async function addPath(path) {
    if (typeof isBrowserOutput === "function" && isBrowserOutput()) {
        await browserAddPath(path);
        return;
    }
    await api("/api/add", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({path: path})
    });
    refresh();
    loadQueue();
}

async function playPath(path) {
    if (typeof isBrowserOutput === "function" && isBrowserOutput()) {
        await browserPlayPath(path);
        showTab("now");
        return;
    }
    await api("/api/playpath", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({path: path})
    });
    refresh();
    loadQueue();
    showTab("now");
}

function playCurrentFolder() {
    if (!currentPath) return;
    playPath(currentPath);
}

async function loadQueue() {
    const box = document.getElementById("queue");
    clearElement(box);
    try {
        const data = await api("/api/queue");
        const queue = data.queue || [];
        const currentId = data.current_id || "";
        if (!queue.length) {
            box.appendChild(makeMeta("Queue empty."));
            return;
        }
        box.appendChild(makeMeta("Drag to reorder"));
        queue.forEach(function(item) {
            const row = document.createElement("div");
            row.className = "item queue-row" + (item.id === currentId ? " current" : "");
            row.draggable = true;
            row.dataset.pos = String(item.pos);
            bindPlayableRow(row, function() { playQueueItem(item.id); });

            row.addEventListener("dragstart", function(ev) {
                row.classList.add("dragging");
                ev.dataTransfer.setData("text/plain", String(item.pos));
                ev.dataTransfer.effectAllowed = "move";
            });
            row.addEventListener("dragend", function() {
                row.classList.remove("dragging");
            });
            row.addEventListener("dragover", function(ev) {
                ev.preventDefault();
                row.classList.add("drag-over");
            });
            row.addEventListener("dragleave", function() {
                row.classList.remove("drag-over");
            });
            row.addEventListener("drop", async function(ev) {
                ev.preventDefault();
                row.classList.remove("drag-over");
                const fromPos = parseInt(ev.dataTransfer.getData("text/plain"), 10);
                const toPos = parseInt(item.pos, 10);
                if (isNaN(fromPos) || isNaN(toPos) || fromPos === toPos) return;
                try {
                    await moveQueueItem(fromPos, toPos);
                    loadQueue();
                } catch (err) {
                    alert(err.message || String(err));
                }
            });

            const left = document.createElement("div");
            const prefix = item.id === currentId ? "▶ " : "";
            left.appendChild(makeTrackLabel(
                prefix + (item.title || shortFileName(item.file)),
                item.file
            ));
            left.appendChild(elText("item-sub", item.artist || shortFolderName(item.file)));
            row.appendChild(left);
            const act = document.createElement("div");
            act.className = "actions";
            act.appendChild(makeBtn("X", function() { removeQueueItem(item.id); }));
            row.appendChild(act);
            box.appendChild(row);
        });
    } catch (e) {
        box.appendChild(makeMeta("Error: " + (e.message || String(e))));
    }
}

async function playQueueItem(id) {
    await api("/api/playqueue", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({id: id})
    });
    refresh();
    loadQueue();
    showTab("now");
}

async function removeQueueItem(id) {
    await api("/api/removequeue", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({id: id})
    });
    refresh();
    loadQueue();
}

async function clearQueue() {
    if (!confirm("Clear queue?")) return;
    await api("/api/clearqueue", {method: "POST"});
    refresh();
    loadQueue();
}

async function createEmptyPlaylist() {
    const name = document.getElementById("playlistName").value.trim();
    if (!name) return alert("Enter a name.");
    await api("/api/createplaylist", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({name: name})
    });
    selectedPlaylist = name;
    await refreshPlaylistNames();
    loadPlaylists();
}

async function loadPlaylists() {
    const box = document.getElementById("playlistList");
    clearElement(box);
    try {
        const playlists = await api("/api/playlists");
        await refreshPlaylistNames();
        playlists.forEach(function(p) {
            const row = document.createElement("div");
            row.className = "item playlist-name-row" + (p.playlist === selectedPlaylist ? " current" : "");

            const nameEl = elText("item-name",
                (p.playlist === LIKED_PLAYLIST ? "♥ " : "") + p.playlist);
            row.appendChild(nameEl);

            const playBtn = makeBtn("▶", function(ev) {
                ev.stopPropagation();
                playPlaylist(p.playlist);
            });
            playBtn.className = "pill accent playlist-name-play";
            playBtn.title = "Play playlist";
            row.appendChild(playBtn);

            row.onclick = function() {
                selectedPlaylist = p.playlist;
                document.getElementById("playlistName").value = p.playlist;
                loadPlaylists();
                loadPlaylistTracksMobile(p.playlist);
            };
            box.appendChild(row);
        });
        if (selectedPlaylist) loadPlaylistTracksMobile(selectedPlaylist);
    } catch (e) {
        box.appendChild(makeMeta("Error: " + (e.message || String(e))));
    }
}

async function loadPlaylistTracksMobile(name) {
    const box = document.getElementById("playlistTracks");
    clearElement(box);
    if (!name) return;

    const head = document.createElement("div");
    head.className = "playlist-tracks-head";
    const title = elText("playlist-tracks-title", name);
    head.appendChild(title);
    const center = document.createElement("div");
    center.className = "playlist-tracks-head-center";
    const playBtn = makeBtn("▶ Play", function() { playPlaylist(name); });
    playBtn.className = "pill accent playlist-play-btn";
    center.appendChild(playBtn);
    head.appendChild(center);
    box.appendChild(head);

    try {
        const data = await apiPlaylist(name);
        (data.tracks || []).forEach(function(t, idx) {
            const row = document.createElement("div");
            row.className = "item";
            bindPlayableRow(row, function() { playPath(t.file); });
            row.appendChild(makeTrackLabel(
                (idx + 1) + ". " + (t.title || shortFileName(t.file)),
                t.file
            ));
            const act = document.createElement("div");
            act.className = "actions";
            act.appendChild(makeBtn("X", function() {
                api("/api/playlistremove", {
                    method: "POST",
                    headers: {"Content-Type": "application/json"},
                    body: JSON.stringify({name: name, pos: t.pos})
                }).then(function() { loadPlaylistTracksMobile(name); });
            }));
            row.appendChild(act);
            box.appendChild(row);
        });
    } catch (e) {
        box.appendChild(makeMeta("Error: " + (e.message || String(e))));
    }
}

async function playPlaylist(name) {
    if (!name) return alert("Select a playlist.");
    selectedPlaylist = name;
    const input = document.getElementById("playlistName");
    if (input) input.value = name;
    await api("/api/loadplaylist", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({name: name})
    });
    refresh();
    loadQueue();
    showTab("now");
}

async function loadSelectedPlaylist() {
    await playPlaylist(selectedPlaylist);
}

async function deleteSelectedPlaylist() {
    if (!selectedPlaylist) return alert("Select a playlist.");
    if (!confirm("Delete " + selectedPlaylist + "?")) return;
    await api("/api/deleteplaylist", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({name: selectedPlaylist})
    });
    selectedPlaylist = "";
    loadPlaylists();
    clearElement(document.getElementById("playlistTracks"));
}

function setLibMode(mode, force, skipLoad) {
    libMode = mode;
    document.getElementById("modeFolders").classList.toggle("active", mode === "folders");
    document.getElementById("modeAlbums").classList.toggle("active", mode === "albums");
    document.getElementById("modeArtists").classList.toggle("active", mode === "artists");
    document.getElementById("folderControls").style.display = mode === "folders" ? "block" : "none";
    document.getElementById("libContext").classList.add("hidden");
    currentArtist = "";
    clearLibFilter();
    updateLibFilterPlaceholder(mode);
    if (skipLoad) return;
    if (mode === "folders") browse(currentPath || "");
    else if (mode === "albums") loadAlbums("");
    else loadArtists();
}

async function browse(path) {
    currentPath = path || "";
    document.getElementById("currentPath").innerText = currentPath || "/";
    const playFolderBtn = document.getElementById("playFolderBtn");
    if (playFolderBtn) {
        playFolderBtn.style.display = currentPath ? "inline-block" : "none";
    }
    clearLibFilter();
    updateLibFilterPlaceholder("folders");
    const box = document.getElementById("browser");
    const cacheKey = path || "";
    const cached = getLibListCache("browse", cacheKey);
    if (cached) {
        renderBrowseList(box, cached);
        applyLibFilter();
    } else {
        clearElement(box);
        box.appendChild(makeMeta("Loading…"));
    }
    try {
        const data = await api("/api/browse?path=" + encodeURIComponent(path || ""));
        setLibListCache("browse", cacheKey, data);
        renderBrowseList(box, data);
        applyLibFilter();
    } catch (e) {
        if (!cached) {
            clearElement(box);
            box.appendChild(makeMeta("Error: " + (e.message || String(e))));
        }
    }
}

function renderBrowseList(box, data) {
    clearElement(box);
    if (!data || !data.length) {
        box.appendChild(makeMeta("Empty."));
        return;
    }
    const frag = document.createDocumentFragment();
    data.forEach(function(item) {
        const isDir = item.type === "directory";
        const rawName = item.name || shortFileName(item.path);
        const displayName = isDir ? cleanReleaseDisplayName(rawName) : rawName;
        const label = isDir ? ("📁 " + displayName) :
            (item.title || item.name || shortFileName(item.path));
        const buttons = [];
        if (isDir) {
            const playBtn = makeBtn("▶", function() { playPath(item.path); });
            playBtn.className = "pill accent play-folder-btn";
            playBtn.title = "Play folder";
            buttons.push(playBtn);
            buttons.push(makeBtn("Add", function() { addPath(item.path); }));
        } else {
            buttons.push(makeBtn("Add", function() { addPath(item.path); }));
            if (typeof makeCastButton === "function") {
                buttons.push(makeCastButton(item.path));
            }
        }
        const onRowClick = isDir ?
            function() { browse(item.path); } :
            function() { playPath(item.path); };
        const trackFile = isDir ? null : item.path;
        frag.appendChild(makeItemRow(
            label,
            item.artist || "",
            buttons,
            onRowClick,
            trackFile,
            isDir ? "folder-row" : ""
        ));
    });
        box.appendChild(frag);
    if (typeof warmCoverCache === "function") {
        const files = [];
        data.forEach(function(item) {
            if (item.type === "file" && item.path) files.push(item.path);
        });
        warmCoverCache({files: files, path: currentPath || ""});
    }
}

function goHome() { currentPath = ""; browse(""); }
function goUp() {
    if (!currentPath) return;
    const parts = currentPath.replace(/^\/+|\/+$/g, "").split("/");
    parts.pop();
    currentPath = parts.join("/");
    browse(currentPath);
}

async function loadArtists(append) {
    const box = document.getElementById("browser");
    if (!append) {
        libPage = {kind: "artists", key: "", offset: 0, total: 0, items: []};
        clearElement(box);
        box.appendChild(makeMeta("Loading…"));
    }
    try {
        const data = await api("/api/artists?limit=" + LIB_PAGE_SIZE + "&offset=" + libPage.offset +
            (getLibFilterQuery() ? ("&q=" + encodeURIComponent(getLibFilterQuery())) : ""));
        const results = data.results || (Array.isArray(data) ? data : []);
        libPage.total = data.total != null ? data.total : results.length;
        libPage.items = append ? libPage.items.concat(results) : results;
        libPage.offset = libPage.items.length;
        renderArtistList(box, libPage.items, libPage.total);
        applyLibFilter();
    } catch (e) {
        if (!append) {
            clearElement(box);
            box.appendChild(makeMeta("Error: " + (e.message || String(e))));
        }
    }
}

function renderArtistList(box, artists, total) {
    clearElement(box);
    if (total && total > artists.length) {
        box.appendChild(makeMeta("Showing " + artists.length + " of " + total));
    }
    const frag = document.createDocumentFragment();
    (artists || []).forEach(function(a) {
        frag.appendChild(makeItemRow("🎤 " + a, "", [], function() { openArtist(a); }));
    });
    box.appendChild(frag);
    if (total && artists.length < total) {
        const more = makeBtn("Show more", function() { loadArtists(true); });
        more.className = "pill accent";
        box.appendChild(more);
    }
}

function openArtist(artist) {
    currentArtist = artist;
    const ctx = document.getElementById("libContext");
    ctx.classList.remove("hidden");
    ctx.innerText = "Albums by " + artist;
    clearLibFilter();
    updateLibFilterPlaceholder("albums");
    loadAlbums(artist);
}

async function loadAlbums(artist, append) {
    const box = document.getElementById("browser");
    const key = artist || "";
    if (!append) {
        libPage = {kind: "albums", key: key, offset: 0, total: 0, items: []};
        clearElement(box);
        box.appendChild(makeMeta("Loading…"));
    }
    try {
        const url = "/api/albums?limit=" + LIB_PAGE_SIZE + "&offset=" + libPage.offset +
            (artist ? ("&artist=" + encodeURIComponent(artist)) : "") +
            (getLibFilterQuery() ? ("&q=" + encodeURIComponent(getLibFilterQuery())) : "");
        const data = await api(url);
        const results = data.results || (Array.isArray(data) ? data : []);
        libPage.total = data.total != null ? data.total : results.length;
        libPage.items = append ? libPage.items.concat(results) : results;
        libPage.offset = libPage.items.length;
        renderAlbumList(box, libPage.items, libPage.total, artist);
        applyLibFilter();
    } catch (e) {
        if (!append) {
            clearElement(box);
            box.appendChild(makeMeta("Error: " + (e.message || String(e))));
        }
    }
}

function renderAlbumList(box, albums, total, artist) {
    clearElement(box);
    if (total && total > albums.length) {
        box.appendChild(makeMeta("Showing " + albums.length + " of " + total));
    }
    const frag = document.createDocumentFragment();
    (albums || []).forEach(function(al) {
        frag.appendChild(makeItemRow("💿 " + al.album, al.albumartist || "", [], function() {
            openAlbum(al);
        }));
    });
    box.appendChild(frag);
    if (typeof warmCoverCache === "function") {
        warmCoverCache({albums: albums});
    }
    if (total && albums.length < total) {
        const more = makeBtn("Show more", function() { loadAlbums(artist, true); });
        more.className = "pill accent";
        box.appendChild(more);
    }
}

async function openAlbum(al) {
    const box = document.getElementById("browser");
    clearElement(box);
    clearLibFilter();
    updateLibFilterPlaceholder("albums");
    const tracks = await api(
        "/api/albumtracks?album=" + encodeURIComponent(al.album) +
        "&albumartist=" + encodeURIComponent(al.albumartist || "")
    );
    const playAllBtn = makeBtn("Play all", function() { addAlbum(al, true); });
    playAllBtn.className = "pill accent";
    const addAllBtn = makeBtn("Add all", function() { addAlbum(al, false); });
    addAllBtn.className = "pill accent";
    box.appendChild(makeItemRow("💿 " + al.album, "", [playAllBtn, addAllBtn]));
    tracks.forEach(function(t) {
        const buttons = [makeBtn("Add", function() { addPath(t.file); })];
        if (typeof makeCastButton === "function") {
            buttons.push(makeCastButton(t.file, {
                title: t.title || "",
                artist: t.artist || "",
                album: al.album || ""
            }));
        }
        box.appendChild(makeItemRow(
            t.title || shortFileName(t.file),
            t.artist || "",
            buttons,
            function() { playPath(t.file); },
            t.file
        ));
    });
    if (typeof warmCoverCache === "function") {
        warmCoverCache({
            files: tracks.map(function(t) { return t.file; }),
            albums: [al]
        });
    }
    applyLibFilter();
}

async function addAlbum(al, play) {
    if (play && typeof isBrowserOutput === "function" && isBrowserOutput()) {
        await browserPlayAlbum(al);
        showTab("now");
        return;
    }
    await api("/api/addalbum", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({album: al.album, albumartist: al.albumartist || "", play: play})
    });
    refresh();
    loadQueue();
    if (play) showTab("now");
}

async function addSimilar() {
    if (typeof isBrowserOutput === "function" && isBrowserOutput()) {
        try {
            const res = await browserRadio("similar", 10);
            if (res && res.added) {
                if (typeof flashPlayerAction === "function") {
                    flashPlayerAction("+" + res.added + " similar");
                }
            }
        } catch (e) {
            alert(e.message || String(e));
        }
        return;
    }
    try {
        const res = await api("/api/similar", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({count: 10})
        });
        if (!res.added) alert("No similar tracks found.");
        refresh();
        loadQueue();
    } catch (e) {
        alert(e.message || String(e));
    }
}

let mobileRadioMode = localStorage.getItem("mpd-radio-mode") || "local";
let mobileBrowserRadioOn = false;

function updateMobileRadioButtons() {
    const localBtn = document.getElementById("radioLocalBtn");
    const smartBtn = document.getElementById("radioSmartBtn");
    const on = mobileBrowserRadioOn || false;
    if (localBtn) {
        localBtn.classList.toggle("active", on && mobileRadioMode === "local");
    }
    if (smartBtn) {
        smartBtn.classList.toggle("active", on && mobileRadioMode === "smart");
    }
}

async function startMobileRadio(mode) {
    const next = mode === "smart" ? "smart" : "local";
    const inBrowser = typeof isBrowserOutput === "function" && isBrowserOutput();

    // Tap same active mode again → stop
    if (inBrowser && mobileBrowserRadioOn && mobileRadioMode === next) {
        mobileBrowserRadioOn = false;
        updateMobileRadioButtons();
        if (typeof flashPlayerAction === "function") flashPlayerAction("Radio off");
        return;
    }

    if (!inBrowser) {
        try {
            const data = await api("/api/radio/status");
            if (data.auto_radio && mobileRadioMode === next) {
                await api("/api/radio/stop", {method: "POST"});
                mobileRadioMode = next;
                localStorage.setItem("mpd-radio-mode", mobileRadioMode);
                updateMobileRadioButtons();
                if (typeof flashPlayerAction === "function") flashPlayerAction("Radio off");
                return;
            }
        } catch (e) {}
    }

    mobileRadioMode = next;
    localStorage.setItem("mpd-radio-mode", mobileRadioMode);

    const btn = document.getElementById(next === "smart" ? "radioSmartBtn" : "radioLocalBtn");
    const prev = btn ? btn.innerText : "";
    if (btn) { btn.disabled = true; btn.innerText = "…"; }

    try {
        if (inBrowser) {
            const res = await browserRadio(next === "smart" ? "smart" : "local", 12);
            if (res && res.added) {
                mobileBrowserRadioOn = true;
                updateMobileRadioButtons();
                if (typeof flashPlayerAction === "function") {
                    flashPlayerAction("Radio · +" + res.added + " · " + (res.source || next));
                }
            } else {
                mobileBrowserRadioOn = false;
                updateMobileRadioButtons();
            }
            return;
        }

        const res = await api("/api/radio/start", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({mode: next, count: 15, replace: false})
        });
        mobileBrowserRadioOn = false;
        updateMobileRadioButtons();
        if (typeof flashPlayerAction === "function") {
            flashPlayerAction("Radio · +" + (res.added || 0) + " · " + (res.source || next));
        }
        refresh();
        loadQueue();
    } catch (e) {
        // MPD offline → fall back to browser radio if a track is already queued there
        const seed = typeof getBrowserNow === "function" ? getBrowserNow() : null;
        if (seed && seed.file && typeof setBrowserOutput === "function") {
            setBrowserOutput(true);
            try {
                const res = await browserRadio(next === "smart" ? "smart" : "local", 12);
                if (res && res.added) {
                    mobileBrowserRadioOn = true;
                    updateMobileRadioButtons();
                    if (typeof flashPlayerAction === "function") {
                        flashPlayerAction("Radio · +" + res.added + " · " + (res.source || next));
                    }
                    return;
                }
            } catch (e2) {
                alert(e2.message || String(e2));
                return;
            }
        }
        alert(e.message || String(e));
    } finally {
        if (btn) { btn.disabled = false; btn.innerText = prev || (next === "smart" ? "S" : "L"); }
        updateMobileRadioButtons();
    }
}

async function smartRadio(evt) {
    await startMobileRadio("smart");
}

async function loadAutoRadio() {
    // Legacy: keep settings panel state if present; radio is L/S on Now Playing.
    try {
        const data = await api("/api/autoradio");
        const autoState = document.getElementById("autoRadioState");
        if (autoState) autoState.innerText = data.enabled ? "On" : "Off";
        if (!(typeof isBrowserOutput === "function" && isBrowserOutput())) {
            mobileBrowserRadioOn = false;
            if (data.enabled) {
                // Reflect MPD auto-radio on the last-used mode button when possible
                updateMobileRadioButtons();
                const btn = document.getElementById(
                    mobileRadioMode === "smart" ? "radioSmartBtn" : "radioLocalBtn"
                );
                if (btn) btn.classList.add("active");
            } else {
                updateMobileRadioButtons();
            }
        }
    } catch (e) {}
}

async function toggleAutoRadio() {
    // Kept for any leftover callers — prefer L/S on the Now Playing row.
    await startMobileRadio(mobileRadioMode === "smart" ? "smart" : "local");
}

window.onBrowserRadioNeedsMore = async function() {
    if (!mobileBrowserRadioOn) return;
    if (!(typeof isBrowserOutput === "function" && isBrowserOutput())) return;
    try {
        await browserRadio(mobileRadioMode === "smart" ? "smart" : "local", 8);
    } catch (e) {}
};

document.getElementById("searchBox").addEventListener("input", debounce(function() {
    searchMusic(false);
}, 300));

function toggleMobileTheme() {
    const light = !document.body.classList.contains("theme-light");
    document.body.classList.toggle("theme-light", light);
    localStorage.setItem("mpd_theme", light ? "light" : "dark");
}

function mobileCoversEnabled() {
    return localStorage.getItem("mpd_covers") !== "off";
}

function applyMobileCovers() {
    const on = mobileCoversEnabled();
    document.body.classList.toggle("covers-off", !on);
    const hint = document.getElementById("coverToggleHint");
    if (hint) hint.innerText = on ? "Cover art on" : "Cover art off";
    const btn = document.getElementById("coverToggleBtn");
    if (btn) btn.classList.toggle("active", on);
    const cover = document.getElementById("coverArt");
    if (!on && cover) {
        cover.classList.add("hidden");
        cover.removeAttribute("src");
        lastCoverKey = "";
    } else if (on && typeof refresh === "function") {
        lastCoverKey = "";
        refresh();
    }
}

function toggleMobileCovers() {
    localStorage.setItem("mpd_covers", mobileCoversEnabled() ? "off" : "on");
    applyMobileCovers();
}

function applyMobileTheme() {
    if (localStorage.getItem("mpd_theme") === "light") {
        document.body.classList.add("theme-light");
    }
}

async function loadMobileRecent() {
    const box = document.getElementById("mobileRecent");
    if (!box) return;
    clearElement(box);
    try {
        const data = await apiRecent();
        const items = (data.items || []).slice(0, 20);
        if (!items.length) {
            box.appendChild(makeMeta("No recent plays."));
            return;
        }
        items.forEach(function(item) {
            box.appendChild(makeItemRow(
                item.title || shortFileName(item.file),
                [item.artist, item.album].filter(Boolean).join(" · "),
                [makeBtn("Add", function() { addPath(item.file); })],
                function() { playPath(item.file); },
                item.file
            ));
        });
    } catch (e) {
        box.appendChild(makeMeta(e.message || String(e)));
    }
}

async function loadRecentPlays() {
    const box = document.getElementById("recentList") || document.getElementById("mobileRecent");
    if (!box) return;
    clearElement(box);
    try {
        const data = await apiRecent();
        const items = data.items || [];
        if (!items.length) {
            box.appendChild(makeMeta("No recent plays yet."));
            return;
        }
        items.forEach(function(item) {
            const buttons = [makeBtn("Add", function() { addPath(item.file); })];
            if (typeof makeCastButton === "function") {
                buttons.push(makeCastButton(item.file, {
                    title: item.title || "",
                    artist: item.artist || "",
                    album: item.album || ""
                }));
            }
            box.appendChild(makeItemRow(
                item.title || shortFileName(item.file),
                [item.artist, item.album].filter(Boolean).join(" · "),
                buttons,
                function() { playPath(item.file); },
                item.file
            ));
        });
        // Keep mini list on Now in sync when present
        if (document.getElementById("mobileRecent") && box.id !== "mobileRecent") {
            loadMobileRecent();
        }
    } catch (e) {
        box.appendChild(makeMeta("Error: " + (e.message || String(e))));
    }
}

async function clearRecentPlays() {
    if (!confirm("Clear recently played?")) return;
    await api("/api/recent/clear", {method: "POST"});
    loadRecentPlays();
    loadMobileRecent();
}

async function openLikedMobile() {
    await openMobileLiked();
}

async function openMobileLiked() {
    showTab("lists");
    if (typeof ensureLikedPlaylist === "function") await ensureLikedPlaylist();
    selectedPlaylist = "Liked Songs";
    await loadPlaylists();
    if (typeof openPlaylist === "function") openPlaylist("Liked Songs");
    else if (typeof loadPlaylistTracks === "function") loadPlaylistTracks("Liked Songs");
    else if (typeof loadPlaylistTracksMobile === "function") loadPlaylistTracksMobile("Liked Songs");
}

applyMobileTheme();
applyMobileCovers();

refreshPlaylistNames().then(function() {
    ensureLikedPlaylist();
    initPlaylistPopover();
    loadPlayers();
    loadAutoRadio();
    refresh();
    setLibMode("folders");
    loadQueue();
    if (typeof refreshDlnaState === "function") {
        refreshDlnaState().then(function(data) {
            const list = document.getElementById("dlnaDeviceList");
            if (list && typeof renderDlnaDeviceList === "function") {
                renderDlnaDeviceList(list, data.devices || []);
            }
            const baseInput = document.getElementById("dlnaPublicBase");
            if (baseInput && data.public_base) baseInput.value = data.public_base;
        }).catch(function() {});
    }
});

setInterval(refresh, 3000);
