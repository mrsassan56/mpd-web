const LIKED_PLAYLIST = "Liked Songs";

let playlistNames = [];
let selectedPlaylist = "";
let currentSongFile = "";
let currentSongTitle = "";
let likedSongFiles = null;
let playlistPopoverOpen = false;

async function refreshPlaylistNames() {
    try {
        const list = await api("/api/playlists");
        playlistNames = (list || []).map(function(p) { return p.playlist; });
    } catch (e) {
        playlistNames = [];
    }
    return playlistNames;
}

async function ensureLikedPlaylist() {
    await refreshPlaylistNames();
    if (playlistNames.indexOf(LIKED_PLAYLIST) < 0) {
        try {
            await api("/api/createplaylist", {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({name: LIKED_PLAYLIST})
            });
            await refreshPlaylistNames();
        } catch (e) {
            // playlistadd also creates on first add
        }
    }
}

function setCurrentTrack(song) {
    song = song || {};
    const file = song.file || "";
    if (file !== currentSongFile) {
        likedSongFiles = null;
    }
    currentSongFile = file;
    currentSongTitle = song.title || file || "";
    if (typeof setDlnaCurrentFile === "function") {
        setDlnaCurrentFile(file);
    }
    updateLikeButton();
}

async function loadLikedFiles() {
    if (likedSongFiles) return likedSongFiles;
    try {
        const data = await apiPlaylist(LIKED_PLAYLIST);
        likedSongFiles = {};
        (data.tracks || []).forEach(function(t) {
            if (t.file) likedSongFiles[t.file] = true;
        });
    } catch (e) {
        likedSongFiles = {};
    }
    return likedSongFiles;
}

async function updateLikeButton() {
    const btn = document.getElementById("likeBtn");
    if (!btn) return;
    if (!currentSongFile) {
        btn.classList.remove("liked");
        btn.disabled = true;
        return;
    }
    btn.disabled = false;
    const liked = await loadLikedFiles();
    btn.classList.toggle("liked", !!liked[currentSongFile]);
}

function flashPlayerAction(msg) {
    const el = document.getElementById("playerActionMsg");
    if (el) {
        el.innerText = msg;
        el.classList.add("visible");
        clearTimeout(flashPlayerAction._t);
        flashPlayerAction._t = setTimeout(function() {
            el.classList.remove("visible");
        }, 2200);
        return;
    }
    const status = document.getElementById("status");
    if (status) {
        const prev = status.innerText;
        status.innerText = msg;
        setTimeout(function() { status.innerText = prev; }, 2200);
    }
}

async function likeCurrentSong() {
    if (!currentSongFile) {
        flashPlayerAction("No song playing");
        return;
    }
    try {
        await ensureLikedPlaylist();
        await addFileToPlaylist(LIKED_PLAYLIST, currentSongFile);
        likedSongFiles = likedSongFiles || {};
        likedSongFiles[currentSongFile] = true;
        updateLikeButton();
        flashPlayerAction("♥ Added to Liked Songs");
        if (typeof loadPlaylists === "function") loadPlaylists();
    } catch (e) {
        flashPlayerAction("Like failed: " + (e.message || String(e)));
    }
}

function closePlaylistPopover() {
    playlistPopoverOpen = false;
    const pop = document.getElementById("playlistPopover");
    if (pop) pop.classList.remove("open");
}

async function togglePlaylistPopover() {
    const pop = document.getElementById("playlistPopover");
    if (!pop) return;

    if (playlistPopoverOpen) {
        closePlaylistPopover();
        return;
    }

    if (!currentSongFile) {
        flashPlayerAction("No song playing");
        return;
    }

    playlistPopoverOpen = true;
    pop.classList.add("open");
    await renderPlaylistPopover();
}

async function renderPlaylistPopover() {
    const listEl = document.getElementById("playlistPopoverList");
    if (!listEl) return;

    clearElement(listEl);
    listEl.appendChild(makeMeta("Loading playlists…"));

    await refreshPlaylistNames();

    clearElement(listEl);

    const names = playlistNames.slice().sort(function(a, b) {
        if (a === LIKED_PLAYLIST) return -1;
        if (b === LIKED_PLAYLIST) return 1;
        return a.localeCompare(b, undefined, {sensitivity: "base"});
    });

    if (!names.length) {
        listEl.appendChild(makeMeta("No playlists yet — create one below."));
    }

    names.forEach(function(name) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "popover-item";
        if (name === LIKED_PLAYLIST) row.className += " popover-liked";
        row.innerText = (name === LIKED_PLAYLIST ? "♥ " : "") + name;
        row.onclick = async function() {
            try {
                await addFileToPlaylist(name, currentSongFile);
                if (name === LIKED_PLAYLIST) {
                    likedSongFiles = likedSongFiles || {};
                    likedSongFiles[currentSongFile] = true;
                    updateLikeButton();
                }
                flashPlayerAction("Added to \"" + name + "\"");
                closePlaylistPopover();
                if (typeof loadPlaylists === "function") loadPlaylists();
                if (selectedPlaylist === name && typeof loadPlaylistTracks === "function") {
                    loadPlaylistTracks(name);
                }
            } catch (e) {
                flashPlayerAction(e.message || String(e));
            }
        };
        listEl.appendChild(row);
    });
}

async function createAndAddToPlaylist() {
    const input = document.getElementById("playlistPopoverNew");
    if (!input) return;
    const name = input.value.trim();
    if (!name) {
        flashPlayerAction("Enter a playlist name");
        return;
    }
    if (!currentSongFile) {
        flashPlayerAction("No song playing");
        return;
    }

    try {
        await api("/api/createplaylist", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({name: name})
        });
        await addFileToPlaylist(name, currentSongFile);
        input.value = "";
        await refreshPlaylistNames();
        flashPlayerAction("Created \"" + name + "\" and added song");
        closePlaylistPopover();
        if (typeof loadPlaylists === "function") loadPlaylists();
    } catch (e) {
        flashPlayerAction(e.message || String(e));
    }
}

function initPlaylistPopover() {
    document.addEventListener("click", function(e) {
        if (!playlistPopoverOpen) return;
        const pop = document.getElementById("playlistPopover");
        const btn = document.getElementById("addToPlaylistBtn");
        if (pop && !pop.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
            closePlaylistPopover();
        }
    });

    const newInput = document.getElementById("playlistPopoverNew");
    if (newInput) {
        newInput.addEventListener("keydown", function(e) {
            if (e.key === "Enter") createAndAddToPlaylist();
        });
    }
}

function makePlaylistSelect(onPick) {
    const sel = document.createElement("select");
    sel.className = "playlist-select";

    const empty = document.createElement("option");
    empty.value = "";
    empty.innerText = "+ Playlist";
    sel.appendChild(empty);

    playlistNames.forEach(function(name) {
        const opt = document.createElement("option");
        opt.value = name;
        opt.innerText = name === LIKED_PLAYLIST ? "♥ " + name : name;
        sel.appendChild(opt);
    });

    sel.onchange = async function() {
        const name = sel.value;
        sel.value = "";
        if (!name) return;
        try {
            await onPick(name);
        } catch (e) {
            alert(e.message || String(e));
        }
    };

    return sel;
}

async function addFileToPlaylist(name, file) {
    await api("/api/playlistadd", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({name: name, file: file})
    });
}
