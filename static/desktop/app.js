let currentPath = "";
let lastSongId = "";
let queueHasItems = false;
let lastCoverKey = "";
let openQueueDetails = {};
let genresLoaded = false;
let genresVisible = false;
let searchMode = "tracks";
let activeView = "now";
let currentSongMeta = {album: "", albumartist: "", artist: ""};

const VIEW_HEADINGS = {
    now: "Now Playing",
    library: "Library",
    search: "Search",
    playlists: "Playlists",
    queue: "Queue",
    recent: "Recently Played",
    settings: "Settings"
};

function showView(name) {
    activeView = name;
    if (name.indexOf("library") === 0) name = "library";

    document.querySelectorAll(".view").forEach(function(el) {
        el.classList.remove("active");
    });
    const panel = document.getElementById("view-" + name);
    if (panel) panel.classList.add("active");

    document.querySelectorAll(".nav-item").forEach(function(btn) {
        const v = btn.getAttribute("data-view") || "";
        btn.classList.toggle("active", v === name || v.indexOf(name) === 0);
    });

    const heading = document.getElementById("viewHeading");
    if (heading) {
        if (name === "library") {
            heading.innerText = libMode === "albums" ? "Albums" :
                libMode === "artists" ? "Artists" : "Folders";
        } else {
            heading.innerText = VIEW_HEADINGS[name] || name;
        }
    }

    if (name === "queue") loadQueue();
    if (name === "playlists") loadPlaylists();
    if (name === "settings") loadSettingsForm();
    if (name === "recent") loadRecentPlays();
    if (name === "search" && searchMode === "genres") toggleGenres(true);
}

function toggleCompactMode() {
    const compact = !document.body.classList.contains("compact-mode");
    document.body.classList.toggle("compact-mode", compact);
    document.body.classList.toggle("full-mode", !compact);
    localStorage.setItem("mpd_layout", compact ? "compact" : "full");
    syncCompactToggle();
}

function toggleThemeMode() {
    const light = !document.body.classList.contains("theme-light");
    document.body.classList.toggle("theme-light", light);
    localStorage.setItem("mpd_theme", light ? "light" : "dark");
    syncThemeToggle();
}

function applyThemePreference() {
    const saved = localStorage.getItem("mpd_theme");
    document.body.classList.toggle("theme-light", saved === "light");
    syncThemeToggle();
}

function syncThemeToggle() {
    const btn = document.getElementById("themeToggle");
    if (!btn) return;
    const light = document.body.classList.contains("theme-light");
    btn.classList.toggle("active", light);
    btn.innerText = light ? "◐ Dark" : "◑ Light";
}

function applyLayoutPreference() {
    const saved = localStorage.getItem("mpd_layout");
    const narrow = window.innerWidth < 720;
    const compact = saved === "compact" || (saved !== "full" && narrow);
    document.body.classList.toggle("compact-mode", compact);
    document.body.classList.toggle("full-mode", saved === "full");
    syncCompactToggle();
}

function syncCompactToggle() {
    const btn = document.getElementById("compactToggle");
    if (!btn) return;
    const compact = document.body.classList.contains("compact-mode");
    btn.classList.toggle("active", compact);
    btn.innerText = compact ? "⊞ Expand" : "⊟ Compact";
}

let desktopRadioMode = localStorage.getItem("mpd-radio-mode") || "local";

function getRadioMode() {
    return desktopRadioMode === "smart" ? "smart" : "local";
}

function updateRadioModeButtons() {
    const localBtn = document.getElementById("radioLocalBtn");
    const smartBtn = document.getElementById("radioSmartBtn");
    if (localBtn) localBtn.classList.toggle("active", desktopRadioMode === "local");
    if (smartBtn) smartBtn.classList.toggle("active", desktopRadioMode === "smart");
}

async function startDesktopRadio(mode) {
    const next = mode === "smart" ? "smart" : "local";
    let running = false;
    try {
        const data = await api("/api/radio/status");
        running = !!data.auto_radio;
    } catch (e) {}
    if (running && desktopRadioMode === next) {
        await stopRadio();
        updateRadioModeButtons();
        return;
    }
    desktopRadioMode = next;
    localStorage.setItem("mpd-radio-mode", desktopRadioMode);
    updateRadioModeButtons();
    await startRadio();
}

async function updateRadioStatus() {
    try {
        const data = await api("/api/radio/status");
        const el = document.getElementById("radioStatus");
        updateRadioModeButtons();
        if (!el) return;
        if (data.auto_radio) {
            el.className = "radio-status active";
            el.innerText = "Radio on · " + (desktopRadioMode === "smart" ? "smart" : "local");
        } else {
            el.className = "radio-status";
            el.innerText = "Radio off · tap L or S next to Output";
        }
    } catch (e) {}
}

async function startRadio() {
    const mode = getRadioMode();
    const statusEl = document.getElementById("radioStatus");
    if (statusEl) {
        statusEl.innerText = mode === "smart" ?
            "Looking up similar artists online…" : "Building radio queue from your library…";
    }

    try {
        if (typeof isBrowserOutput === "function" && isBrowserOutput()) {
            const res = await browserRadio(mode === "smart" ? "smart" : "local", 15);
            if (statusEl) {
                if (res && res.added) {
                    statusEl.className = "radio-status active";
                    statusEl.innerText = "Browser radio · +" + res.added + " · " + (res.source || mode);
                } else {
                    statusEl.innerText = "Browser radio — no tracks (play a tagged song first)";
                }
            }
            return;
        }

        const res = await api("/api/radio/start", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({mode: mode, count: 15, replace: false})
        });

        let msg = "Radio on · added " + res.added + " tracks";
        if (res.source === "listenbrainz" || res.source === "smart") {
            msg += " · smart";
            if (res.artists && res.artists.length) {
                msg += " (" + res.artists.slice(0, 3).join(", ") + ")";
            }
        } else {
            msg += " · based on genre/artist tags";
        }

        if (statusEl) {
            statusEl.className = "radio-status active";
            statusEl.innerText = msg;
        }

        refresh();
        loadQueue();
        updateRadioStatus();
    } catch (e) {
        if (statusEl) statusEl.innerText = "Failed: " + (e.message || String(e));
    }
}

async function stopRadio() {
    await api("/api/radio/stop", {method: "POST"});
    updateRadioStatus();
}

async function savePlaylist() {
    const name = document.getElementById("playlistName").value.trim();
    if (!name) return;

    await api("/api/saveplaylist", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({name: name})
    });

    await refreshPlaylistNames();
    loadPlaylists();
    selectPlaylist(name);
}

async function createEmptyPlaylist() {
    const name = document.getElementById("playlistName").value.trim();
    if (!name) {
        alert("Type a playlist name first.");
        return;
    }

    await api("/api/createplaylist", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({name: name})
    });

    document.getElementById("playlistName").value = "";
    await refreshPlaylistNames();
    loadPlaylists();
    selectPlaylist(name);
}

async function loadPlaylists() {
    const box = document.getElementById("playlistList");
    clearElement(box);

    try {
        const playlists = await api("/api/playlists");
        await refreshPlaylistNames();

        if (!playlists.length) {
            box.appendChild(makeMeta("No playlists yet."));
            return;
        }

        playlists.sort(function(a, b) {
            if (a.playlist === LIKED_PLAYLIST) return -1;
            if (b.playlist === LIKED_PLAYLIST) return 1;
            return a.playlist.localeCompare(b.playlist, undefined, {sensitivity: "base"});
        });

        playlists.forEach(function(p) {
            const row = document.createElement("div");
            row.className = "item playlist-name-row";
            if (p.playlist === selectedPlaylist) {
                row.className += " selected";
            }
            if (p.playlist === LIKED_PLAYLIST) {
                row.className += " playlist-liked";
            }

            const nameSpan = document.createElement("span");
            nameSpan.className = "item-name";
            nameSpan.innerText = (p.playlist === LIKED_PLAYLIST ? "♥ " : "") + p.playlist;
            row.appendChild(nameSpan);

            const playBtn = makeButton("▶", function(ev) {
                ev.stopPropagation();
                playPlaylist(p.playlist);
            });
            playBtn.className = "pill accent playlist-name-play";
            playBtn.title = "Play playlist";
            row.appendChild(playBtn);

            row.onclick = function() { selectPlaylist(p.playlist); };
            box.appendChild(row);
        });

        if (selectedPlaylist) {
            loadPlaylistTracks(selectedPlaylist);
        }
    } catch (e) {
        box.appendChild(makeMeta("Playlist error: " + (e.message || String(e))));
    }
}

function selectPlaylist(name) {
    selectedPlaylist = name;
    document.getElementById("playlistName").value = name;
    loadPlaylists();
    loadPlaylistTracks(name);
}

function makePlaylistTracksHeader(name) {
    const head = document.createElement("div");
    head.className = "playlist-tracks-head";

    const title = document.createElement("span");
    title.className = "playlist-tracks-title";
    title.innerText = name;
    head.appendChild(title);

    const center = document.createElement("div");
    center.className = "playlist-tracks-head-center";
    const playBtn = makeButton("▶ Play", function() { playPlaylist(name); });
    playBtn.className = "pill accent playlist-play-btn";
    center.appendChild(playBtn);
    head.appendChild(center);

    return head;
}

async function loadPlaylistTracks(name) {
    const box = document.getElementById("playlistTracks");
    clearElement(box);

    if (!name) {
        box.appendChild(makeMeta("Select a playlist."));
        return;
    }

    box.appendChild(makePlaylistTracksHeader(name));
    box.appendChild(makeMeta("Loading..."));

    try {
        const data = await apiPlaylist(name);
        clearElement(box);
        box.appendChild(makePlaylistTracksHeader(name));

        const tracks = data.tracks || [];
        if (!tracks.length) {
            box.appendChild(makeMeta("Empty playlist."));
            return;
        }

        tracks.forEach(function(t, idx) {
            const row = document.createElement("div");
            row.className = "item";
            bindPlayableRow(row, function() {
                if (typeof isBrowserOutput === "function" && isBrowserOutput() &&
                    typeof browserPlayPlaylist === "function") {
                    browserPlayPlaylist(name, idx);
                    return;
                }
                playPath(t.file);
            });

            const left = document.createElement("div");
            left.appendChild(makeTrackLabel(
                (idx + 1) + ". " + (t.title || shortFileName(t.file)),
                t.file,
                "queue-title track-label"
            ));

            if (t.artist || t.album) {
                left.appendChild(makeMeta([t.artist, t.album].filter(Boolean).join(" · ")));
            }

            const actions = document.createElement("div");
            actions.className = "actions queue-actions";

            actions.appendChild(makeButton("▲", function() {
                movePlaylistTrack(name, t.pos, Math.max(0, Number(t.pos) - 1));
            }));
            actions.appendChild(makeButton("▼", function() {
                movePlaylistTrack(name, t.pos, Number(t.pos) + 1);
            }));
            actions.appendChild(makeButton("Remove", function() {
                removePlaylistTrack(name, t.pos);
            }));

            row.appendChild(left);
            row.appendChild(actions);
            box.appendChild(row);
        });
    } catch (e) {
        clearElement(box);
        box.appendChild(makeMeta("Error: " + (e.message || String(e))));
    }
}

async function removePlaylistTrack(name, pos) {
    await api("/api/playlistremove", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({name: name, pos: pos})
    });
    loadPlaylistTracks(name);
}

async function movePlaylistTrack(name, fromPos, toPos) {
    if (fromPos === toPos) return;
    await api("/api/playlistmove", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({name: name, from: fromPos, to: toPos})
    });
    loadPlaylistTracks(name);
}

async function playPlaylist(name) {
    if (!name) {
        alert("Select a playlist first.");
        return;
    }
    selectedPlaylist = name;
    const input = document.getElementById("playlistName");
    if (input) input.value = name;
    if (typeof isBrowserOutput === "function" && isBrowserOutput() &&
        typeof browserPlayPlaylist === "function") {
        await browserPlayPlaylist(name, 0);
        if (typeof showView === "function") showView("now");
        return;
    }
    await api("/api/loadplaylist", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({name: name})
    });
    loadQueue();
    refresh();
    if (typeof showView === "function") showView("now");
}

async function loadSelectedPlaylist() {
    await playPlaylist(selectedPlaylist);
}

async function deleteSelectedPlaylist() {
    if (!selectedPlaylist) {
        alert("Select a playlist first.");
        return;
    }
    if (!confirm("Delete playlist \"" + selectedPlaylist + "\"?")) return;

    await api("/api/deleteplaylist", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({name: selectedPlaylist})
    });

    selectedPlaylist = "";
    await refreshPlaylistNames();
    loadPlaylists();
    loadPlaylistTracks("");
}

async function renameSelectedPlaylist() {
    if (!selectedPlaylist) {
        alert("Select a playlist first.");
        return;
    }
    const newName = prompt("Rename playlist to:", selectedPlaylist);
    if (!newName || newName === selectedPlaylist) return;

    await api("/api/renameplaylist", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({old: selectedPlaylist, new: newName})
    });

    selectedPlaylist = newName;
    await refreshPlaylistNames();
    loadPlaylists();
}

function addPlaylistAction(actions, file) {
    const sel = makePlaylistSelect(async function(name) {
        await addFileToPlaylist(name, file);
        if (selectedPlaylist === name) {
            loadPlaylistTracks(name);
        }
    });
    actions.appendChild(sel);
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

        if (lastSongId && songId && songId !== lastSongId && queueHasItems) {
            loadQueue();
        }

        lastSongId = songId;

        const title = song.title || song.file || "No song";
        const artist = song.artist || "";
        const album = song.album || "";
        const folder = song.file ? folderFromFilePath(song.file) : "";
        currentSongMeta = {
            album: album,
            albumartist: song.albumartist || "",
            artist: artist
        };

        document.getElementById("title").innerText = title;
        document.getElementById("artist").innerText = artist;
        document.getElementById("album").innerText = album;
        document.getElementById("folderName").innerText = folder ? "📁 " + folder : "";
        syncGotoAlbumButtons(!!album);

        const heroTitle = document.getElementById("heroTitle");
        const heroArtist = document.getElementById("heroArtist");
        const heroAlbum = document.getElementById("heroAlbum");
        const heroFormat = document.getElementById("heroFormat");
        const barFormat = document.getElementById("barFormat");
        const heroFolder = document.getElementById("heroFolder");
        const audioInfo = formatAudioInfo(song, status);
        if (heroTitle) heroTitle.innerText = title;
        if (heroArtist) heroArtist.innerText = artist;
        if (heroAlbum) heroAlbum.innerText = album;
        if (heroFormat) {
            heroFormat.innerText = audioInfo;
            heroFormat.style.display = audioInfo ? "inline-block" : "none";
        }
        if (barFormat) {
            barFormat.innerText = audioInfo;
            barFormat.style.display = audioInfo ? "inline-block" : "none";
        }
        if (heroFolder) heroFolder.innerText = folder ? folder : "";

        document.getElementById("randomState").innerText =
            status.random === "1" ? "On" : "Off";

        const elapsed = Math.floor(status.elapsed || 0);
        const duration = Math.floor(status.duration || 0);

        document.getElementById("status").innerText =
            (status.state || "—") + "  ·  " +
            formatDuration(elapsed) + " / " + formatDuration(duration);

        updatePlayPauseButton(status.state);
        if (typeof isBrowserOutput === "function" && isBrowserOutput()) {
            if (typeof applyBrowserNowToUI === "function") applyBrowserNowToUI();
            if (typeof updateSleepTimerUI === "function") {
                updateSleepTimerUI(data.sleep_timer);
            }
            return;
        }
        if (typeof updateSleepTimerUI === "function") {
            updateSleepTimerUI(data.sleep_timer);
        }

        const cover = document.getElementById("coverArt");
        const heroCover = document.getElementById("heroCover");
        const heroPlaceholder = document.getElementById("heroPlaceholder");
        const coverKey = (song.file || "") + "|" + songId;
        const coverUrl = song.file ?
            "/api/cover?file=" + encodeURIComponent(song.file) +
            "&id=" + encodeURIComponent(songId || "") : "";

        if (song.file && coverKey !== lastCoverKey) {
            lastCoverKey = coverKey;

            cover.style.display = "block";
            cover.src = coverUrl;
            cover.onerror = function() { cover.style.display = "none"; };

            if (heroCover) {
                heroCover.style.display = "block";
                heroCover.src = coverUrl;
                heroCover.onerror = function() {
                    heroCover.style.display = "none";
                    if (heroPlaceholder) heroPlaceholder.style.display = "flex";
                };
            }
            if (heroPlaceholder) heroPlaceholder.style.display = "none";
        }

        if (!song.file) {
            cover.style.display = "none";
            if (heroCover) heroCover.style.display = "none";
            if (heroPlaceholder) heroPlaceholder.style.display = "flex";
            lastCoverKey = "";
            document.getElementById("folderName").innerText = "";
            const barFormatClear = document.getElementById("barFormat");
            if (barFormatClear) {
                barFormatClear.innerText = "";
                barFormatClear.style.display = "none";
            }
            currentSongMeta = {album: "", albumartist: "", artist: ""};
            syncGotoAlbumButtons(false);
        }

        setCurrentTrack(song);

    } catch (e) {
        document.getElementById("title").innerText = "Cannot connect to MPD";
        document.getElementById("artist").innerText = e.message || String(e);
        const heroTitle = document.getElementById("heroTitle");
        if (heroTitle) heroTitle.innerText = "Cannot connect to MPD";
        syncGotoAlbumButtons(false);
    }
}

function syncGotoAlbumButtons(show) {
    ["heroGotoAlbum", "barGotoAlbum"].forEach(function(id) {
        const btn = document.getElementById(id);
        if (btn) btn.style.display = show ? "inline-flex" : "none";
    });
}

function goToPlayingAlbum() {
    if (!currentSongMeta.album) return;
    setLibMode("albums", true, true);
    openAlbum({
        album: currentSongMeta.album,
        albumartist: currentSongMeta.albumartist || currentSongMeta.artist || ""
    });
}


async function cmd(name) {
    try {
        if (typeof isBrowserOutput === "function" && isBrowserOutput() &&
            (name === "next" || name === "previous" || name === "stop")) {
            await browserCmd(name);
            if (name === "next" || name === "previous" || name === "stop") {
                loadQueue();
            }
            return;
        }
        await api("/api/" + name, {method: "POST"});
        refresh();

        if (name === "next" || name === "previous" || name === "stop") {
            loadQueue();
        }

    } catch (e) {
        alert(e.message || String(e));
    }
}


async function toggleRandom() {
    try {
        await api("/api/random", {method: "POST"});
        refresh();
    } catch (e) {
        alert(e.message || String(e));
    }
}


async function browse(path = "") {
    currentPath = path;
    document.getElementById("currentPath").innerText = currentPath || "/";
    const playFolderBtn = document.getElementById("playFolderBtn");
    if (playFolderBtn) {
        playFolderBtn.style.display = currentPath ? "inline-flex" : "none";
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
        const data = await api("/api/browse?path=" + encodeURIComponent(path));
        setLibListCache("browse", cacheKey, data);
        renderBrowseList(box, data);
        applyLibFilter();
    } catch (e) {
        if (!cached) {
            clearElement(box);
            box.appendChild(makeMeta("Browse error: " + (e.message || String(e))));
        }
    }
}

function renderBrowseList(box, data) {
    clearElement(box);
    if (!data || !data.length) {
        box.appendChild(makeMeta("Empty folder"));
        return;
    }

    const frag = document.createDocumentFragment();
    data.forEach(function(item) {
        const row = document.createElement("div");
        row.className = "item" + (item.type === "file" ? " playable-row" : "");

        const left = document.createElement("div");
        const name = document.createElement("div");
        name.className = "item-name";

        if (item.type === "directory") {
            name.className += " directory";
            name.innerText = "📁 " + cleanReleaseDisplayName(item.name || shortFileName(item.path));
            name.onclick = function() {
                browse(item.path);
            };
            left.appendChild(name);
        } else {
            const title = item.title || item.name || shortFileName(item.path);
            left.appendChild(makeTrackLabel(title, item.path));
            bindPlayableRow(row, function() { playPath(item.path); });
        }

        if (item.type === "file" && (item.artist || item.album)) {
            let metaText = "";
            if (item.artist) metaText += item.artist;
            if (item.album) metaText += (metaText ? " • " : "") + item.album;
            left.appendChild(makeMeta(metaText));
        }

        const actions = document.createElement("div");
        actions.className = "actions";

        if (item.type === "directory") {
            const playFolderBtn = makeButton("▶", function() {
                playPath(item.path);
            });
            playFolderBtn.className = "pill accent play-folder-btn";
            playFolderBtn.title = "Play folder";
            actions.appendChild(playFolderBtn);
            actions.appendChild(makeButton("Add", function() {
                addPath(item.path);
            }));
        } else {
            actions.appendChild(makeButton("Add", function() {
                addPath(item.path);
            }));
            if (typeof makeCastButton === "function") {
                actions.appendChild(makeCastButton(item.path));
            }
            addPlaylistAction(actions, item.path);
        }

        row.appendChild(left);
        row.appendChild(actions);
        frag.appendChild(row);
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

function goHome() {
    currentPath = "";
    browse("");
}

function goUp() {
    if (!currentPath || currentPath === "/") {
        currentPath = "";
        browse("");
        return;
    }

    let normalized = currentPath.replace(/^\/+|\/+$/g, "");
    if (!normalized) {
        currentPath = "";
        browse("");
        return;
    }

    const parts = normalized.split("/");
    parts.pop();

    const parent = parts.join("/");
    currentPath = parent;
    browse(parent);
}


function setSearchMode(mode) {
    searchMode = mode;
    showView("search");
    document.querySelectorAll("#searchChips button").forEach(function(btn) {
        btn.classList.toggle("active", btn.getAttribute("data-mode") === mode);
    });
    if (mode === "genres") {
        toggleGenres(true);
        return;
    }
    genresVisible = false;
    document.getElementById("genres").classList.add("queue-hidden");
    document.getElementById("searchResults").classList.remove("queue-hidden");
    searchMusic();
}

let searchPage = {q: "", mode: "", offset: 0, total: 0, items: []};
let searchSeq = 0;

async function searchMusic(append) {
    append = append === true;
    const q = document.getElementById("searchBox").value.trim();
    const box = document.getElementById("searchResults");
    const seq = append ? searchSeq : ++searchSeq;

    if (!append) {
        clearElement(box);
        searchPage = {q: q, mode: searchMode, offset: 0, total: 0, items: []};
    }

    if (!q) {
        box.appendChild(makeMeta("Type to search..."));
        return;
    }

    if (searchMode === "genres") {
        toggleGenres(true);
        return;
    }

    if (!append) {
        box.appendChild(makeMeta("Searching..."));
    }

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
        if (append) {
            searchPage.items = searchPage.items.concat(results);
        } else {
            searchPage.items = results;
        }
        searchPage.offset = searchPage.items.length;

        clearElement(box);

        if (!searchPage.items.length) {
            box.appendChild(makeMeta("No results (" + (searchPage.total || 0) + ")."));
            return;
        }

        if (searchPage.total > searchPage.items.length) {
            box.appendChild(makeMeta("Showing " + searchPage.items.length + " of " + searchPage.total));
        }

        renderSearchResults(box, searchPage.items);

        if (searchPage.items.length < searchPage.total) {
            const more = makeButton("Show more", function() { searchMusic(true); });
            more.className = "pill accent lib-more-btn";
            box.appendChild(more);
        }
    } catch (e) {
        if (seq !== searchSeq) return;
        if (!append) {
            clearElement(box);
            box.appendChild(makeMeta("Search error: " + (e.message || String(e))));
        }
    }
}

function renderSearchResults(box, results) {
    if (searchMode === "albums") {
        const grid = document.createElement("div");
        grid.className = "album-grid search-album-grid";
        results.forEach(function(al) {
            const card = document.createElement("div");
            card.className = "album-card";

            const img = document.createElement("img");
            img.loading = "lazy";
            img.decoding = "async";
            img.src = "/api/albumcover?album=" + encodeURIComponent(al.album) +
                "&albumartist=" + encodeURIComponent(al.albumartist || "");
            img.onerror = function() { img.style.visibility = "hidden"; };
            card.appendChild(img);

            const nm = document.createElement("div");
            nm.className = "a-name";
            nm.innerText = al.album;
            card.appendChild(nm);

            if (al.albumartist) {
                const ar = document.createElement("div");
                ar.className = "a-artist";
                ar.innerText = al.albumartist;
                card.appendChild(ar);
            }

            card.onclick = function() {
                setLibMode("albums", true, true);
                openAlbum({album: al.album, albumartist: al.albumartist || ""});
            };
            grid.appendChild(card);
        });
        box.appendChild(grid);
        if (typeof warmCoverCache === "function") {
            warmCoverCache({albums: results});
        }
        return;
    }

    if (searchMode === "artists") {
        const grid = document.createElement("div");
        grid.className = "album-grid search-artist-grid";
        results.forEach(function(ar) {
            const card = document.createElement("div");
            card.className = "album-card artist-card";
            bindPlayableRow(card, function() { openArtist(ar.artist); });

            const icon = document.createElement("div");
            icon.className = "artist-card-icon";
            icon.innerText = "🎤";
            card.appendChild(icon);

            const nm = document.createElement("div");
            nm.className = "a-name";
            nm.innerText = ar.artist;
            card.appendChild(nm);

            const meta = document.createElement("div");
            meta.className = "a-artist";
            meta.innerText = ar.track_count + " tracks";
            card.appendChild(meta);

            grid.appendChild(card);
        });
        box.appendChild(grid);
        return;
    }

    results.forEach(function(item) {
        const row = document.createElement("div");
        row.className = "item search-result-row";
        bindPlayableRow(row, function() { playPath(item.file); });

        const img = document.createElement("img");
        img.className = "search-thumb";
        img.loading = "lazy";
        img.src = "/api/albumcover?album=" + encodeURIComponent(item.album || "") +
            "&albumartist=" + encodeURIComponent(item.albumartist || item.artist || "");
        img.onerror = function() { img.style.visibility = "hidden"; };
        row.appendChild(img);

        const left = document.createElement("div");
        left.className = "item-main";
        left.appendChild(makeTrackLabel(item.title || item.file, item.file));

        let metaText = "";
        if (item.artist) metaText += item.artist;
        if (item.album) metaText += (metaText ? " · " : "") + item.album;
        if (metaText) left.appendChild(makeMeta(metaText));
        row.appendChild(left);

        const actions = document.createElement("div");
        actions.className = "actions";
        if (item.album) {
            const goAlbum = makeButton("→", function() {
                setLibMode("albums", true, true);
                openAlbum({
                    album: item.album,
                    albumartist: item.albumartist || item.artist || ""
                });
            });
            goAlbum.className = "pill accent search-goto-album";
            goAlbum.title = "Go to album";
            actions.appendChild(goAlbum);
        }
        actions.appendChild(makeButton("Add", function() { addPath(item.file); }));
        if (typeof makeCastButton === "function") {
            actions.appendChild(makeCastButton(item.file, {
                title: item.title || "",
                artist: item.artist || "",
                album: item.album || ""
            }));
        }
        addPlaylistAction(actions, item.file);
        row.appendChild(actions);
        box.appendChild(row);
    });
}

const debouncedSearch = debounce(function() { searchMusic(false); }, 300);

async function addPath(path) {
    try {
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

    } catch (e) {
        alert(e.message || String(e));
    }
}


async function playPath(path) {
    try {
        if (typeof isBrowserOutput === "function" && isBrowserOutput()) {
            await browserPlayPath(path);
            return;
        }
        await api("/api/playpath", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({path: path})
        });

        refresh();
        loadQueue();

    } catch (e) {
        alert(e.message || String(e));
    }
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

        queueHasItems = queue.length > 0;

        if (!queue.length) {
            box.appendChild(makeMeta("Queue is empty."));
            return;
        }

        box.appendChild(makeMeta("Drag rows to reorder"));

        queue.forEach(function(item) {
            const row = document.createElement("div");
            row.className = "item queue-row";
            row.draggable = true;
            row.dataset.pos = String(item.pos);
            row.dataset.id = String(item.id || "");
            bindPlayableRow(row, function() { playQueueItem(item.id); });

            if (item.id && item.id === currentId) {
                row.className += " queue-current";
            }

            row.addEventListener("dragstart", function(ev) {
                row.classList.add("dragging");
                ev.dataTransfer.setData("text/plain", String(item.pos));
                ev.dataTransfer.effectAllowed = "move";
            });
            row.addEventListener("dragend", function() {
                row.classList.remove("dragging");
                box.querySelectorAll(".queue-row").forEach(function(r) {
                    r.classList.remove("drag-over");
                });
            });
            row.addEventListener("dragover", function(ev) {
                ev.preventDefault();
                ev.dataTransfer.dropEffect = "move";
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

            let numberText = "";
            if (item.id && item.id === currentId) {
                numberText = "▶ ";
            } else {
                numberText = (Number(item.pos) + 1) + ". ";
            }

            left.appendChild(makeTrackLabel(
                numberText + (item.title || shortFileName(item.file) || "Unknown track"),
                item.file,
                "queue-title track-label"
            ));

            const subtitle = document.createElement("div");
            subtitle.className = "queue-subtitle";

            let subtitleText = "";

            if (item.artist) {
                subtitleText += item.artist;
            }

            if (item.album) {
                if (subtitleText) {
                    subtitleText += " - ";
                }
                subtitleText += item.album;
            }

            if (!subtitleText) {
                subtitleText = shortFolderName(item.file);
            }

            subtitle.innerText = subtitleText;
            left.appendChild(subtitle);

            const details = document.createElement("div");
            details.className = "queue-details";

            if (!openQueueDetails[item.id]) {
                details.className += " queue-hidden";
            }

            details.innerText = "File: " + (item.file || "");
            left.appendChild(details);

            const actions = document.createElement("div");
            actions.className = "actions queue-actions";

            actions.appendChild(makeButton("Remove", function() {
                removeQueueItem(item.id);
            }));

            const moreBtn = makeButton(openQueueDetails[item.id] ? "Less" : "More", function() {
                if (openQueueDetails[item.id]) {
                    delete openQueueDetails[item.id];
                } else {
                    openQueueDetails[item.id] = true;
                }

                loadQueue();
            });

            actions.appendChild(moreBtn);

            row.appendChild(left);
            row.appendChild(actions);
            box.appendChild(row);
        });

    } catch (e) {
        box.appendChild(makeMeta("Queue error: " + (e.message || String(e))));
    }
}


async function playQueueItem(id) {
    try {
        await api("/api/playqueue", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({id: id})
        });

        refresh();
        loadQueue();

    } catch (e) {
        alert(e.message || String(e));
    }
}


async function removeQueueItem(id) {
    try {
        await api("/api/removequeue", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({id: id})
        });

        refresh();
        loadQueue();

    } catch (e) {
        alert(e.message || String(e));
    }
}


async function clearQueue() {
    if (!confirm("Clear current queue?")) {
        return;
    }

    try {
        await api("/api/clearqueue", {
            method: "POST"
        });

        refresh();
        loadQueue();

    } catch (e) {
        alert(e.message || String(e));
    }
}


async function toggleGenres(forceShow) {
    const box = document.getElementById("genres");
    const results = document.getElementById("searchResults");

    if (forceShow === true) {
        genresVisible = true;
    } else if (genresVisible) {
        genresVisible = false;
        box.classList.add("queue-hidden");
        results.classList.remove("queue-hidden");
        return;
    } else {
        genresVisible = true;
    }

    box.classList.remove("queue-hidden");
    results.classList.add("queue-hidden");

    if (!genresLoaded) {
        await loadGenres();
        genresLoaded = true;
    }
}


async function loadGenres() {
    const box = document.getElementById("genres");
    clearElement(box);

    try {
        const genres = await api("/api/genres");

        if (!genres.length) {
            box.appendChild(makeMeta("No genres found."));
            return;
        }

        genres.forEach(function(g) {
            const row = document.createElement("div");
            row.className = "item";

            const name = document.createElement("div");
            name.className = "item-name";
            name.innerText = "🎼 " + g;

            const actions = document.createElement("div");
            actions.className = "actions";

            actions.appendChild(makeButton("Play Random", function() {
                playGenre(g);
            }));

            row.appendChild(name);
            row.appendChild(actions);
            box.appendChild(row);
        });

    } catch (e) {
        box.appendChild(makeMeta("Genre error: " + (e.message || String(e))));
    }
}


async function playGenre(genre) {
    try {
        const result = await api("/api/playgenre", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({genre: genre})
        });

        alert("Playing " + result.tracks + " tracks from genre: " + genre);
        refresh();
        loadQueue();

    } catch (e) {
        alert(e.message || String(e));
    }
}


async function updateDatabase() {
    try {
        const result = await api("/api/update", {method: "POST"});
        clearLibListCache();
        alert("MPD database update started. Job: " + result.job);
    } catch (e) {
        alert(e.message || String(e));
    }
}


let libMode = "folders";
let currentArtist = "";
const LIB_PAGE_SIZE = 20;
let libPage = {kind: "", key: "", offset: 0, total: 0, items: []};

async function loadPlayers() {
    try {
        const data = await api("/api/players");
        const sel = document.getElementById("playerSelect");

        clearElement(sel);

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
    const sel = document.getElementById("playerSelect");
    const key = sel.value;

    try {
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
        loadPlaylists();
        setLibMode(libMode, true);

    } catch (e) {
        alert(e.message || String(e));
    }
}


function setLibMode(mode, force, skipLoad) {
    libMode = mode;
    showView("library");

    const folderControls = document.getElementById("folderControls");
    if (folderControls) {
        folderControls.style.display = mode === "folders" ? "flex" : "none";
    }

    document.getElementById("modeFolders").classList.toggle("active", mode === "folders");
    document.getElementById("modeAlbums").classList.toggle("active", mode === "albums");
    document.getElementById("modeArtists").classList.toggle("active", mode === "artists");

    document.querySelectorAll(".nav-item").forEach(function(btn) {
        const v = btn.getAttribute("data-view") || "";
        btn.classList.toggle("active", v === "library-" + mode);
    });

    const heading = document.getElementById("viewHeading");
    if (heading) {
        heading.innerText = mode === "albums" ? "Albums" :
            mode === "artists" ? "Artists" : "Folders";
    }

    const ctx = document.getElementById("libContext");
    ctx.style.display = "none";
    clearElement(ctx);

    currentArtist = "";

    clearLibFilter();
    updateLibFilterPlaceholder(mode);

    if (skipLoad) return;

    if (mode === "folders") {
        browse(currentPath || "");
    } else if (mode === "albums") {
        loadAlbums("");
    } else if (mode === "artists") {
        loadArtists();
    }
}


function setLibContext(text, backFn) {
    const ctx = document.getElementById("libContext");
    clearElement(ctx);
    ctx.style.display = "block";

    if (backFn) {
        ctx.appendChild(makeButton("⬅ Back", backFn));
    }

    const span = document.createElement("span");
    span.style.marginLeft = "8px";
    span.innerText = text;
    ctx.appendChild(span);
}


async function loadArtists(append) {
    const box = document.getElementById("browser");
    if (!append) {
        libPage = {kind: "artists", key: "", offset: 0, total: 0, items: []};
        clearElement(box);
        box.appendChild(makeMeta("Loading artists..."));
    }

    try {
        const data = await api("/api/artists?limit=" + LIB_PAGE_SIZE + "&offset=" + libPage.offset +
            (getLibFilterQuery() ? ("&q=" + encodeURIComponent(getLibFilterQuery())) : ""));
        const results = data.results || (Array.isArray(data) ? data : []);
        libPage.total = data.total != null ? data.total : results.length;
        if (append) {
            libPage.items = libPage.items.concat(results);
        } else {
            libPage.items = results;
        }
        libPage.offset = libPage.items.length;
        renderArtistList(box, libPage.items, libPage.total);
        applyLibFilter();
    } catch (e) {
        if (!append) {
            clearElement(box);
            box.appendChild(makeMeta("Artist error: " + (e.message || String(e))));
        }
    }
}

function renderArtistList(box, artists, total) {
    clearElement(box);
    if (!artists || !artists.length) {
        box.appendChild(makeMeta("No artists found."));
        return;
    }

    if (total && total > artists.length) {
        box.appendChild(makeMeta("Showing " + artists.length + " of " + total));
    }

    const frag = document.createDocumentFragment();
    artists.forEach(function(a) {
        const row = document.createElement("div");
        row.className = "item";
        bindPlayableRow(row, function() { openArtist(a); });

        const name = document.createElement("div");
        name.className = "item-name directory";
        name.innerText = "🎤 " + a;

        const actions = document.createElement("div");
        actions.className = "actions";
        actions.appendChild(makeButton("Albums", function() { openArtist(a); }));

        row.appendChild(name);
        row.appendChild(actions);
        frag.appendChild(row);
    });
    box.appendChild(frag);

    if (total && artists.length < total) {
        const more = makeButton("Show more", function() { loadArtists(true); });
        more.className = "pill accent lib-more-btn";
        box.appendChild(more);
    }
}


function openArtist(artist) {
    currentArtist = artist;
    clearLibFilter();
    updateLibFilterPlaceholder("albums");
    setLibContext("Albums by " + artist, function() {
        setLibMode("artists", true);
    });
    loadAlbums(artist);
}


async function loadAlbums(artist, append) {
    const box = document.getElementById("browser");
    const key = artist || "";
    if (!append) {
        libPage = {kind: "albums", key: key, offset: 0, total: 0, items: []};
        clearElement(box);
        box.appendChild(makeMeta("Loading albums..."));
    }

    try {
        const url = "/api/albums?limit=" + LIB_PAGE_SIZE + "&offset=" + libPage.offset +
            (artist ? ("&artist=" + encodeURIComponent(artist)) : "") +
            (getLibFilterQuery() ? ("&q=" + encodeURIComponent(getLibFilterQuery())) : "");
        const data = await api(url);
        const results = data.results || (Array.isArray(data) ? data : []);
        libPage.total = data.total != null ? data.total : results.length;
        if (append) {
            libPage.items = libPage.items.concat(results);
        } else {
            libPage.items = results;
        }
        libPage.offset = libPage.items.length;
        renderAlbumGrid(box, libPage.items, libPage.total, artist);
        applyLibFilter();
    } catch (e) {
        if (!append) {
            clearElement(box);
            box.appendChild(makeMeta("Album error: " + (e.message || String(e))));
        }
    }
}

function renderAlbumGrid(box, albums, total, artist) {
    clearElement(box);
    if (!albums || !albums.length) {
        box.appendChild(makeMeta("No albums found."));
        return;
    }

    if (total && total > albums.length) {
        box.appendChild(makeMeta("Showing " + albums.length + " of " + total));
    }

    const grid = document.createElement("div");
    grid.className = "album-grid";

    albums.forEach(function(al) {
        const card = document.createElement("div");
        card.className = "album-card";

        const img = document.createElement("img");
        img.loading = "lazy";
        img.decoding = "async";
        img.src = "/api/albumcover?album=" + encodeURIComponent(al.album) +
                  "&albumartist=" + encodeURIComponent(al.albumartist || "");
        img.onerror = function() { img.style.visibility = "hidden"; };
        card.appendChild(img);

        const nm = document.createElement("div");
        nm.className = "a-name";
        nm.innerText = al.album;
        card.appendChild(nm);

        if (al.albumartist) {
            const ar = document.createElement("div");
            ar.className = "a-artist";
            ar.innerText = al.albumartist;
            card.appendChild(ar);
        }

        card.onclick = function() { openAlbum(al); };
        grid.appendChild(card);
    });

        box.appendChild(grid);

    if (typeof warmCoverCache === "function") {
        warmCoverCache({albums: albums});
    }

    if (total && albums.length < total) {
        const more = makeButton("Show more", function() { loadAlbums(artist, true); });
        more.className = "pill accent lib-more-btn";
        box.appendChild(more);
    }
}


async function openAlbum(al) {
    const box = document.getElementById("browser");
    clearElement(box);
    clearLibFilter();
    updateLibFilterPlaceholder("albums");
    box.appendChild(makeMeta("Loading tracks..."));

    setLibContext(al.album + (al.albumartist ? (" — " + al.albumartist) : ""), function() {
        if (currentArtist) {
            openArtist(currentArtist);
        } else {
            setLibMode("albums", true);
        }
    });

    try {
        const tracks = await api(
            "/api/albumtracks?album=" + encodeURIComponent(al.album) +
            "&albumartist=" + encodeURIComponent(al.albumartist || "")
        );
        clearElement(box);

        const head = document.createElement("div");
        head.className = "item";

        const hleft = document.createElement("div");
        hleft.className = "item-name";
        hleft.innerText = "💿 " + al.album;

        const hact = document.createElement("div");
        hact.className = "actions";
        const playAlbumBtn = makeButton("Play album", function() { addAlbum(al, true); });
        playAlbumBtn.className = "pill accent";
        const addAlbumBtn = makeButton("Add album", function() { addAlbum(al, false); });
        addAlbumBtn.className = "pill accent";
        hact.appendChild(playAlbumBtn);
        hact.appendChild(addAlbumBtn);

        head.appendChild(hleft);
        head.appendChild(hact);
        box.appendChild(head);

        if (!tracks.length) {
            box.appendChild(makeMeta("No tracks."));
            return;
        }

        tracks.forEach(function(t) {
            const row = document.createElement("div");
            row.className = "item";
            bindPlayableRow(row, function() { playPath(t.file); });

            const left = document.createElement("div");
            const num = t.track ? (String(t.track).split("/")[0] + ". ") : "";
            left.appendChild(makeTrackLabel(num + (t.title || shortFileName(t.file)), t.file));

            if (t.artist) {
                left.appendChild(makeMeta(t.artist));
            }

            const actions = document.createElement("div");
            actions.className = "actions";
            actions.appendChild(makeButton("Add", function() { addPath(t.file); }));
            if (typeof makeCastButton === "function") {
                actions.appendChild(makeCastButton(t.file, {
                    title: t.title || "",
                    artist: t.artist || "",
                    album: al.album || ""
                }));
            }
            addPlaylistAction(actions, t.file);

            row.appendChild(left);
            row.appendChild(actions);
            box.appendChild(row);
        });
        if (typeof warmCoverCache === "function") {
            warmCoverCache({
                files: tracks.map(function(t) { return t.file; }),
                albums: [al]
            });
        }
        applyLibFilter();

    } catch (e) {
        clearElement(box);
        box.appendChild(makeMeta("Track error: " + (e.message || String(e))));
    }
}


async function addAlbum(al, play) {
    try {
        if (play && typeof isBrowserOutput === "function" && isBrowserOutput()) {
            await browserPlayAlbum(al);
            return;
        }
        await api("/api/addalbum", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({
                album: al.album,
                albumartist: al.albumartist || "",
                play: play
            })
        });

        refresh();
        loadQueue();

    } catch (e) {
        alert(e.message || String(e));
    }
}


async function addSimilar() {
    try {
        if (typeof isBrowserOutput === "function" && isBrowserOutput()) {
            const res = await browserRadio("similar", 8);
            const statusEl = document.getElementById("radioStatus");
            if (statusEl && res && res.added) {
                statusEl.innerText = "Browser · added " + res.added + " similar tracks";
            }
            return;
        }
        const res = await api("/api/similar", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({count: 8})
        });

        if (!res.added) {
            alert("No similar tracks found to add.");
            return;
        }

        const statusEl = document.getElementById("radioStatus");
        if (statusEl) {
            statusEl.innerText = "Added " + res.added + " similar tracks to queue";
        }

        refresh();
        loadQueue();
    } catch (e) {
        alert(e.message || String(e));
    }
}


async function loadRecentPlays() {
    const box = document.getElementById("recentList");
    if (!box) return;
    clearElement(box);
    box.appendChild(makeMeta("Loading…"));
    try {
        const data = await apiRecent();
        const items = data.items || [];
        clearElement(box);
        if (!items.length) {
            box.appendChild(makeMeta("No recent plays yet. Play something and it will show up here."));
            return;
        }
        items.forEach(function(item) {
            const row = document.createElement("div");
            row.className = "item";
            bindPlayableRow(row, function() { playPath(item.file); });

            const left = document.createElement("div");
            left.className = "item-main";
            left.appendChild(makeTrackLabel(item.title || shortFileName(item.file), item.file));
            const metaBits = [item.artist, item.album].filter(Boolean);
            if (item.played_at) {
                try {
                    metaBits.push(new Date(item.played_at * 1000).toLocaleString());
                } catch (e) {}
            }
            if (metaBits.length) left.appendChild(makeMeta(metaBits.join(" · ")));

            const actions = document.createElement("div");
            actions.className = "actions";
            actions.appendChild(makeButton("Add", function() { addPath(item.file); }));
            if (typeof makeCastButton === "function") {
                actions.appendChild(makeCastButton(item.file, {
                    title: item.title || "",
                    artist: item.artist || "",
                    album: item.album || ""
                }));
            }
            addPlaylistAction(actions, item.file);

            row.appendChild(left);
            row.appendChild(actions);
            box.appendChild(row);
        });
    } catch (e) {
        clearElement(box);
        box.appendChild(makeMeta("Error: " + (e.message || String(e))));
    }
}

async function clearRecentPlays() {
    if (!confirm("Clear recently played?")) return;
    await api("/api/recent/clear", {method: "POST"});
    loadRecentPlays();
}

async function openLikedFavorites() {
    showView("playlists");
    if (typeof ensureLikedPlaylist === "function") await ensureLikedPlaylist();
    await loadPlaylists();
    if (typeof selectPlaylist === "function") {
        selectPlaylist("Liked Songs");
    } else {
        selectedPlaylist = "Liked Songs";
        loadPlaylistTracks("Liked Songs");
    }
}

document.getElementById("searchBox").addEventListener("input", debouncedSearch);
window.addEventListener("resize", debounce(applyLayoutPreference, 200));
applyLayoutPreference();
applyThemePreference();

refreshPlaylistNames().then(function() {
    ensureLikedPlaylist();
    initPlaylistPopover();
    loadPlayers();
    loadPlaylists();
    updateRadioStatus();
    refresh();
    showView("now");
    loadQueue();
    if (typeof refreshDlnaState === "function") refreshDlnaState().catch(function() {});
});


setInterval(function() {
    refresh();
}, 3000);