from flask import Flask, jsonify, request, Response, send_from_directory, redirect
from mpd import MPDClient
import os
import re
import random
import json
import ssl
import threading
import time
import mimetypes
import urllib.request
import urllib.parse
import urllib.error

import dlna_cast

# Default players (used when config.json is missing).
DEFAULT_PLAYERS = {
    "ifi": {"name": "iFi Zen Stream", "host": "192.168.9.92", "port": 6600, "password": None, "music_root": "/store"},
    "mac": {"name": "Mac", "host": "192.168.9.137", "port": 6600, "password": None, "music_root": "/store"},
}

PLAYERS = {}
DEFAULT_PLAYER = "ifi"
current_player = "ifi"
DLNA_CONFIG = {
    "public_base": "",
    "selected_udn": "",
    "selected_location": "",
    "selected_name": "",
}
LISTENBRAINZ_CONFIG = {
    "enabled": False,
    "token": "",
    "username": "",
}
RECENT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "recent_plays.json")
RECENT_MAX = 100
_recent_lock = threading.Lock()
_sleep_lock = threading.Lock()
SLEEP_TIMER = {
    "mode": None,  # None | "minutes" | "album"
    "until": None,
    "minutes": None,
    "album": "",
    "albumartist": "",
}
_scrobble_state = {
    "songid": "",
    "file": "",
    "title": "",
    "artist": "",
    "album": "",
    "started": 0.0,
    "duration": 0.0,
    "scrobbled": False,
    "playing_now_sent": False,
}
_scrobble_lock = threading.Lock()
CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")
_config_lock = threading.RLock()

# Short-lived caches for browse/artists/albums (keyed by player host).
_lib_cache = {}
_lib_cache_lock = threading.Lock()
LIB_CACHE_TTL = 90

# Disk library index when MPD is offline (music_root walk).
_disk_lib = {"ts": 0.0, "root": "", "tracks": None, "artists": None, "albums": None}
_disk_lib_lock = threading.Lock()
DISK_LIB_TTL = 300


def lib_cache_key(*parts):
    player = active_player()
    host = str(player.get("host", ""))
    return "|".join([host] + [str(p) for p in parts])


def lib_cache_get(key):
    with _lib_cache_lock:
        entry = _lib_cache.get(key)
        if not entry:
            return None
        if time.time() - entry[0] > LIB_CACHE_TTL:
            _lib_cache.pop(key, None)
            return None
        return entry[1]


def lib_cache_set(key, value):
    with _lib_cache_lock:
        _lib_cache[key] = (time.time(), value)


def lib_cache_clear():
    with _lib_cache_lock:
        _lib_cache.clear()
    with _disk_lib_lock:
        _disk_lib["ts"] = 0.0
        _disk_lib["tracks"] = None
        _disk_lib["artists"] = None
        _disk_lib["albums"] = None


def normalize_player_entry(info):
    port = info.get("port", 6600)
    try:
        port = int(port)
    except Exception:
        port = 6600
    password = info.get("password")
    if password == "":
        password = None
    music_root = info.get("music_root")
    if music_root == "":
        music_root = None
    return {
        "name": str(info.get("name", "")).strip() or "Player",
        "host": str(info.get("host", "")).strip(),
        "port": port,
        "password": password,
        "music_root": music_root,
    }


def normalize_dlna_config(raw):
    if not isinstance(raw, dict):
        raw = {}
    return {
        "public_base": str(raw.get("public_base") or "").strip().rstrip("/"),
        "selected_udn": str(raw.get("selected_udn") or "").strip(),
        "selected_location": str(raw.get("selected_location") or "").strip(),
        "selected_name": str(raw.get("selected_name") or "").strip(),
    }


def normalize_listenbrainz_config(raw):
    if not isinstance(raw, dict):
        raw = {}
    return {
        "enabled": bool(raw.get("enabled")),
        "token": str(raw.get("token") or "").strip(),
        "username": str(raw.get("username") or "").strip(),
    }


def load_config():
    global PLAYERS, DEFAULT_PLAYER, current_player, DLNA_CONFIG, LISTENBRAINZ_CONFIG
    with _config_lock:
        data = {}
        if os.path.exists(CONFIG_PATH):
            try:
                with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                    data = json.load(f) or {}
            except Exception:
                data = {}

        raw = data.get("players") or {}
        PLAYERS = {}
        if isinstance(raw, dict):
            for key, info in raw.items():
                if isinstance(info, dict):
                    PLAYERS[str(key)] = normalize_player_entry(info)

        if not PLAYERS:
            PLAYERS = {k: normalize_player_entry(v) for k, v in DEFAULT_PLAYERS.items()}
            DEFAULT_PLAYER = "ifi"
            if not os.path.exists(CONFIG_PATH):
                DLNA_CONFIG = normalize_dlna_config({})
                LISTENBRAINZ_CONFIG = normalize_listenbrainz_config({})
                save_config()
        else:
            DEFAULT_PLAYER = str(data.get("default_player", "ifi"))

        DLNA_CONFIG = normalize_dlna_config(data.get("dlna"))
        LISTENBRAINZ_CONFIG = normalize_listenbrainz_config(data.get("listenbrainz"))

        if DEFAULT_PLAYER not in PLAYERS and PLAYERS:
            DEFAULT_PLAYER = next(iter(PLAYERS))
        if current_player not in PLAYERS:
            current_player = DEFAULT_PLAYER


def save_config():
    with _config_lock:
        existing = {}
        if os.path.exists(CONFIG_PATH):
            try:
                with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                    existing = json.load(f) or {}
            except Exception:
                existing = {}
        existing["default_player"] = DEFAULT_PLAYER
        existing["players"] = PLAYERS
        existing["dlna"] = normalize_dlna_config(DLNA_CONFIG)
        existing["listenbrainz"] = normalize_listenbrainz_config(LISTENBRAINZ_CONFIG)
        with open(CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(existing, f, indent=2)


load_config()

# Smart radio (online): uses ListenBrainz + MusicBrainz to find artists related
# to the current song, then queues tracks by those artists FROM YOUR LIBRARY.
# Open, free, no account/key. MusicBrainz asks that you identify your app:
SMART_RADIO_USER_AGENT = "mpd-web-controller/1.0 (personal use)"

# ListenBrainz similar-artists algorithm (their default tuning).
LB_ALGORITHM = (
    "session_based_days_7500_session_300_contribution_5_"
    "threshold_10_limit_100_filter_True_skip_30"
)

# Flask debug/reloader — keep False on the Pi (systemd service).
DEBUG = False

# Auto-radio: when ON, a background thread tops up the queue from your library
# whenever fewer than AUTO_RADIO_THRESHOLD songs remain after the current one.
AUTO_RADIO_ENABLED = False
AUTO_RADIO_THRESHOLD = 3
AUTO_RADIO_BATCH = 5

app = Flask(__name__)


def active_player():
    return PLAYERS.get(current_player) or next(iter(PLAYERS.values()))


def get_mpd(timeout=10):
    player = active_player()

    client = MPDClient()
    client.timeout = timeout
    client.idletimeout = None
    client.connect(player["host"], player["port"])

    if player.get("password"):
        client.password(player["password"])

    return client


def _mpd_error_message(exc):
    msg = str(exc) or exc.__class__.__name__
    low = msg.lower()
    if "timed out" in low or "timeout" in low:
        return "MPD connection timed out — player may be busy or unreachable"
    if any(s in low for s in ("connection refused", "nodename", "name or service",
                              "network is unreachable", "no route to host",
                              "errno 61", "errno 111", "errno 113")):
        return "MPD player is offline or unreachable"
    return msg


def with_mpd(fn, timeout=10):
    client = None
    try:
        client = get_mpd(timeout=timeout)
        result = fn(client)
        clear_mpd_down()
        return result
    except Exception as e:
        mark_mpd_down()
        # Always return JSON for API routes — never leak the Werkzeug HTML debugger.
        if request.path.startswith("/api/"):
            return jsonify({"ok": False, "error": _mpd_error_message(e)}), 500
        raise
    finally:
        if client is not None:
            try:
                client.close()
                client.disconnect()
            except Exception:
                pass


_mpd_down_until = 0.0
_mpd_down_lock = threading.Lock()
MPD_DOWN_TTL = 45


def mark_mpd_down():
    global _mpd_down_until
    with _mpd_down_lock:
        _mpd_down_until = time.time() + MPD_DOWN_TTL


def is_mpd_marked_down():
    with _mpd_down_lock:
        return time.time() < _mpd_down_until


def clear_mpd_down():
    global _mpd_down_until
    with _mpd_down_lock:
        _mpd_down_until = 0.0


def with_mpd_or(fn, fallback, timeout=10, connect_timeout=2):
    """Run fn(client) when MPD is up; otherwise use fallback() (e.g. disk library).

    connect_timeout stays short so offline players fall back to disk quickly.
    After a failure, skip MPD for a short period to keep browse snappy.
    """
    if is_mpd_marked_down():
        try:
            return fallback()
        except Exception as e2:
            if request.path.startswith("/api/"):
                return jsonify({"ok": False, "error": _mpd_error_message(e2)}), 500
            raise

    client = None
    try:
        client = get_mpd(timeout=connect_timeout)
        if timeout != connect_timeout:
            client.timeout = timeout
        result = fn(client)
        clear_mpd_down()
        return result
    except Exception:
        mark_mpd_down()
        try:
            return fallback()
        except Exception as e2:
            if request.path.startswith("/api/"):
                return jsonify({"ok": False, "error": _mpd_error_message(e2)}), 500
            raise
    finally:
        if client is not None:
            try:
                client.close()
                client.disconnect()
            except Exception:
                pass


# Audio extensions for disk browse when MPD is offline (browser / music_root).
AUDIO_EXTS = {
    ".flac", ".mp3", ".wav", ".wave", ".aiff", ".aif",
    ".m4a", ".aac", ".ogg", ".opus", ".dsf", ".dff", ".wv", ".ape",
}


def music_root_abs():
    root = active_player().get("music_root")
    if not root:
        return None
    try:
        return os.path.realpath(root)
    except Exception:
        return None


def resolve_music_dir(rel_path):
    """Resolve an MPD-relative directory under music_root. Returns (abs_path, err)."""
    root = music_root_abs()
    if not root:
        return None, "music_root not configured for this player"
    rel = (rel_path or "").lstrip("/")
    full = os.path.realpath(os.path.join(root, rel)) if rel else root
    if full != root and not full.startswith(root + os.sep):
        return None, "invalid path"
    if not os.path.isdir(full):
        return None, "directory not found on disk"
    return full, None


def is_audio_filename(name):
    return os.path.splitext(name or "")[1].lower() in AUDIO_EXTS


def clean_release_name(name):
    """Strip format tags and year suffixes from folder names."""
    name = (name or "").strip()
    name = re.sub(r"\s*\[[^\]]*\]\s*$", "", name).strip()
    name = re.sub(r"\s*\((?:19|20)\d{2}\)\s*$", "", name).strip()
    return name


def parse_artist_album_folder(folder_name):
    """Parse 'Artist - Album (year) [spec]' style folder names."""
    cleaned = clean_release_name(folder_name)
    if " - " in cleaned:
        artist, album = cleaned.split(" - ", 1)
        artist = artist.strip()
        album = album.strip()
        if artist and album:
            return artist, album
    return "", cleaned or (folder_name or "").strip()


def infer_tags_from_path(rel_file):
    """Guess artist/album/title from a relative library path."""
    parts = [p for p in (rel_file or "").replace("\\", "/").split("/") if p]
    if not parts:
        return {"artist": "", "album": "", "title": "", "albumartist": ""}
    filename = parts[-1]
    title = os.path.splitext(filename)[0]
    title = re.sub(r"^\d{1,3}\s*[.\-_)\s]+", "", title).strip() or title
    dirs = parts[:-1]
    album_dir = dirs[-1] if dirs else ""
    parsed_artist, parsed_album = parse_artist_album_folder(album_dir)

    if len(dirs) >= 3:
        # Category/Artist/Album/file
        artist = dirs[-2]
        album = clean_release_name(album_dir) or album_dir
    elif len(dirs) == 2 and parsed_artist:
        # Category/Artist - Album/file
        artist = parsed_artist
        album = parsed_album
    elif len(dirs) >= 2:
        artist = dirs[-2]
        album = clean_release_name(album_dir) or album_dir
    else:
        artist = parsed_artist
        album = parsed_album or album_dir

    return {
        "artist": artist,
        "album": album,
        "albumartist": artist,
        "title": title,
    }


def browse_from_disk(path=""):
    full, err = resolve_music_dir(path)
    if err:
        raise RuntimeError(err)
    root = music_root_abs()
    items = []
    try:
        entries = sorted(os.listdir(full), key=lambda s: s.lower())
    except Exception as e:
        raise RuntimeError(str(e) or "Cannot read music folder")

    for name in entries:
        if name.startswith("."):
            continue
        abs_path = os.path.join(full, name)
        rel = os.path.relpath(abs_path, root).replace("\\", "/")
        if os.path.isdir(abs_path):
            items.append({"type": "directory", "name": name, "path": rel})
        elif os.path.isfile(abs_path) and is_audio_filename(name):
            tags = infer_tags_from_path(rel)
            items.append({
                "type": "file",
                "name": name,
                "path": rel,
                "title": tags.get("title", ""),
                "artist": tags.get("artist", ""),
                "album": tags.get("album", ""),
                "duration": "",
            })
    return items


def list_folder_tracks_from_disk(path, limit=500):
    full, err = resolve_music_dir(path)
    if err:
        raise RuntimeError(err)
    root = music_root_abs()
    tracks = []
    for dirpath, _dirnames, filenames in os.walk(full):
        filenames = sorted(filenames, key=lambda s: s.lower())
        for name in filenames:
            if not is_audio_filename(name):
                continue
            abs_path = os.path.join(dirpath, name)
            rel = os.path.relpath(abs_path, root).replace("\\", "/")
            tags = infer_tags_from_path(rel)
            tracks.append({
                "file": rel,
                "title": tags.get("title", ""),
                "artist": tags.get("artist", ""),
                "album": tags.get("album", ""),
                "albumartist": tags.get("albumartist", ""),
            })
            if len(tracks) >= limit:
                return tracks
    return tracks


def build_disk_library_index():
    """Build artist/album lists from folder structure (fast — scandir, no file walk)."""
    root = music_root_abs()
    if not root or not os.path.isdir(root):
        return {"tracks": [], "artists": [], "albums": []}

    artists = set()
    albums = {}
    skip_top = {"system volume information", "3tb", "lost+found", "$recycle.bin"}

    try:
        top_entries = os.listdir(root)
    except Exception:
        return {"tracks": [], "artists": [], "albums": []}

    for top in top_entries:
        if top.startswith(".") or top.lower() in skip_top:
            continue
        top_path = os.path.join(root, top)
        if not os.path.isdir(top_path):
            continue

        try:
            mid_entries = os.listdir(top_path)
        except Exception:
            continue

        for mid in mid_entries:
            if mid.startswith("."):
                continue
            mid_path = os.path.join(top_path, mid)
            if not os.path.isdir(mid_path):
                continue

            has_subdir = False
            has_audio = False
            subdirs = []
            try:
                with os.scandir(mid_path) as it:
                    for ent in it:
                        if ent.name.startswith("."):
                            continue
                        try:
                            if ent.is_dir(follow_symlinks=False):
                                has_subdir = True
                                subdirs.append(ent.name)
                            elif ent.is_file(follow_symlinks=False) and is_audio_filename(ent.name):
                                has_audio = True
                        except Exception:
                            pass
            except Exception:
                continue

            if has_subdir and not has_audio:
                # Category/Artist/Album...
                artists.add(mid)
                for album_dir in subdirs:
                    album_name = clean_release_name(album_dir) or album_dir
                    key = (album_name.lower(), mid.lower())
                    if key not in albums:
                        albums[key] = {"album": album_name, "albumartist": mid}
            elif has_subdir:
                artists.add(mid)
                for album_dir in subdirs:
                    album_name = clean_release_name(album_dir) or album_dir
                    key = (album_name.lower(), mid.lower())
                    if key not in albums:
                        albums[key] = {"album": album_name, "albumartist": mid}
            else:
                # Category/Artist - Album/ (tracks directly in folder)
                parsed_artist, parsed_album = parse_artist_album_folder(mid)
                if parsed_artist:
                    artists.add(parsed_artist)
                    key = (parsed_album.lower(), parsed_artist.lower())
                    if key not in albums:
                        albums[key] = {"album": parsed_album, "albumartist": parsed_artist}
                elif has_audio:
                    album_name = clean_release_name(mid) or mid
                    key = (album_name.lower(), top.lower())
                    if key not in albums:
                        albums[key] = {"album": album_name, "albumartist": top}

    artist_list = sorted(artists, key=str.lower)
    album_list = sorted(
        albums.values(),
        key=lambda a: ((a.get("albumartist") or "").lower(), (a.get("album") or "").lower()),
    )
    return {"tracks": [], "artists": artist_list, "albums": album_list}


def get_disk_library(force=False):
    root = music_root_abs() or ""
    now = time.time()
    with _disk_lib_lock:
        fresh = (
            not force
            and _disk_lib["artists"] is not None
            and _disk_lib["root"] == root
            and (now - _disk_lib["ts"]) < DISK_LIB_TTL
        )
        if fresh:
            return {
                "tracks": _disk_lib["tracks"] or [],
                "artists": _disk_lib["artists"],
                "albums": _disk_lib["albums"],
            }

    built = build_disk_library_index()
    with _disk_lib_lock:
        _disk_lib["ts"] = time.time()
        _disk_lib["root"] = root
        _disk_lib["tracks"] = built["tracks"]
        _disk_lib["artists"] = built["artists"]
        _disk_lib["albums"] = built["albums"]
    return built


def disk_album_tracks(album, albumartist=""):
    """Find tracks for an album by scanning likely folders under music_root."""
    album = (album or "").strip()
    albumartist = (albumartist or "").strip()
    if not album:
        return []
    root = music_root_abs()
    if not root:
        return []

    album_l = album.lower()
    aa_l = albumartist.lower()
    scored_dirs = []  # (score, path)

    def folder_matches(base, rel_dir):
        cleaned = clean_release_name(base).lower()
        parsed_artist, parsed_album = parse_artist_album_folder(base)
        exact = (
            cleaned == album_l
            or parsed_album.lower() == album_l
            or base.lower() == album_l
        )
        soft = (not exact) and (album_l in cleaned or cleaned in album_l)
        if not exact and not soft:
            return 0
        if aa_l:
            parent = os.path.basename(os.path.dirname(os.path.join(root, rel_dir))) if rel_dir else ""
            artist_ok = (
                parent.lower() == aa_l
                or parsed_artist.lower() == aa_l
                or aa_l in (rel_dir or "").lower()
            )
            if not artist_ok:
                return 0
        return 2 if exact else 1

    # Fast path: look under Category/<albumartist>/ first.
    try:
        tops = os.listdir(root)
    except Exception:
        tops = []

    for top in tops:
        if top.startswith(".") or top.lower() in ("3tb", "lost+found", "system volume information"):
            continue
        top_path = os.path.join(root, top)
        if not os.path.isdir(top_path):
            continue

        search_mids = []
        if aa_l:
            exact = os.path.join(top_path, albumartist)
            if os.path.isdir(exact):
                search_mids.append((albumartist, exact))
            else:
                try:
                    for mid in os.listdir(top_path):
                        if mid.lower() == aa_l and os.path.isdir(os.path.join(top_path, mid)):
                            search_mids.append((mid, os.path.join(top_path, mid)))
                            break
                except Exception:
                    pass
        else:
            search_mids.append(("", top_path))

        for mid_name, mid_path in search_mids:
            try:
                with os.scandir(mid_path) as it:
                    for ent in it:
                        if ent.name.startswith(".") or not ent.is_dir(follow_symlinks=False):
                            continue
                        rel = os.path.relpath(ent.path, root).replace("\\", "/")
                        score = folder_matches(ent.name, rel)
                        if score:
                            scored_dirs.append((score, ent.path))
                rel_mid = os.path.relpath(mid_path, root).replace("\\", "/")
                score = folder_matches(mid_name or os.path.basename(mid_path), rel_mid)
                if score:
                    scored_dirs.append((score, mid_path))
            except Exception:
                pass

        if not scored_dirs and not aa_l:
            try:
                with os.scandir(top_path) as it:
                    for ent in it:
                        if not ent.is_dir(follow_symlinks=False):
                            continue
                        rel = os.path.join(top, ent.name)
                        score = folder_matches(ent.name, rel)
                        if score:
                            scored_dirs.append((score, ent.path))
            except Exception:
                pass

    if not scored_dirs:
        for dirpath, dirnames, _filenames in os.walk(root):
            rel_dir = os.path.relpath(dirpath, root).replace("\\", "/")
            top = rel_dir.split("/", 1)[0] if rel_dir != "." else ""
            if top.lower() in ("3tb", "lost+found", "system volume information"):
                dirnames[:] = []
                continue
            depth = 0 if rel_dir == "." else rel_dir.count("/") + 1
            if depth > 4:
                dirnames[:] = []
                continue
            base = os.path.basename(dirpath)
            score = folder_matches(base, "" if rel_dir == "." else rel_dir)
            if score:
                scored_dirs.append((score, dirpath))
                dirnames[:] = []
            if len(scored_dirs) >= 5:
                break

    scored_dirs.sort(key=lambda x: -x[0])
    candidate_dirs = []
    seen_dirs = set()
    for score, path in scored_dirs:
        if path in seen_dirs:
            continue
        seen_dirs.add(path)
        candidate_dirs.append(path)
        if score >= 2:
            break
        if len(candidate_dirs) >= 3:
            break

    matches = []
    seen = set()
    for folder in candidate_dirs:
        folder_matches_list = []
        for dirpath, _dns, filenames in os.walk(folder):
            for name in sorted(filenames, key=lambda s: s.lower()):
                if not is_audio_filename(name):
                    continue
                abs_path = os.path.join(dirpath, name)
                rel = os.path.relpath(abs_path, root).replace("\\", "/")
                if rel in seen:
                    continue
                seen.add(rel)
                tags = infer_tags_from_path(rel)
                folder_matches_list.append({
                    "file": rel,
                    "title": tags.get("title", ""),
                    "artist": tags.get("artist", "") or albumartist,
                    "album": tags.get("album", "") or album,
                    "track": "",
                    "duration": "",
                })
        if folder_matches_list:
            matches = folder_matches_list
            break

    matches.sort(key=lambda x: (x.get("file") or "").lower())
    return matches


def disk_search_tracks(query, search_type="any"):
    """Offline search using the folder index (no full-library walk)."""
    fields, free = parse_search_query(query)
    q = (free or query or "").strip().lower()
    if not q and not fields:
        return []

    lib = get_disk_library()
    hits = []
    seen = set()

    album_hits = []
    for a in lib.get("albums") or []:
        album = a.get("album") or ""
        aa = a.get("albumartist") or ""
        blob = (album + " " + aa).lower()
        if q and q not in blob:
            continue
        album_hits.append(a)
        if len(album_hits) >= 30:
            break

    for a in album_hits:
        album = a.get("album") or ""
        aa = a.get("albumartist") or ""
        for t in disk_album_tracks(album, aa)[:25]:
            f = t.get("file")
            if not f or f in seen:
                continue
            seen.add(f)
            hits.append({
                "file": f,
                "title": t.get("title", ""),
                "artist": t.get("artist", "") or aa,
                "album": t.get("album", "") or album,
                "albumartist": aa,
                "genre": "",
                "date": "",
                "duration": "",
            })
            if len(hits) >= 100:
                break
        if len(hits) >= 100:
            break

    clean = []
    for track in hits:
        sc = score_track(track, query, fields, free)
        if sc < 0:
            path_l = (track.get("file") or "").lower()
            if free and free.lower() in path_l:
                sc = 15
            elif q and q in path_l:
                sc = 12
            else:
                continue
        if search_type in ("artist", "album", "title", "genre"):
            val = (track.get(search_type) or "").lower()
            if query.lower() not in val and query.lower() not in (track.get("file") or "").lower():
                continue
        item = dict(track)
        item["_score"] = sc
        clean.append(item)
    clean.sort(key=lambda x: x.get("_score", 0), reverse=True)
    for t in clean:
        t.pop("_score", None)
    return clean


STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")


@app.route("/")
def desktop():
    return send_from_directory(os.path.join(STATIC_DIR, "desktop"), "index.html")


@app.route("/m")
@app.route("/m/")
@app.route("/mobile")
@app.route("/mobile/")
def mobile():
    # Prefer short /m; keep /mobile as an alias.
    if request.path.rstrip("/").endswith("/mobile"):
        return redirect("/m", code=302)
    return send_from_directory(os.path.join(STATIC_DIR, "mobile"), "index.html")


@app.route("/static/<path:filename>")
def static_files(filename):
    return send_from_directory(STATIC_DIR, filename)


@app.route("/api/saveplaylist", methods=["POST"])
def save_playlist_api():
    name = request.json.get("name", "").strip()

    if not name:
        return jsonify({"ok": False}), 400

    def run(client):
        try:
            client.rm(name)
        except:
            pass

        client.save(name)

        return jsonify({"ok": True})

    return with_mpd(run)

@app.route("/api/playlists")
def playlists_api():

    def run(client):
        return jsonify(client.listplaylists())

    return with_mpd(run)

@app.route("/api/loadplaylist", methods=["POST"])
def load_playlist_api():

    name = request.json.get("name", "").strip()

    def run(client):
        client.clear()
        client.load(name)
        client.play()

        return jsonify({"ok": True})

    return with_mpd(run)


@app.route("/api/playlistadd", methods=["POST"])
def playlist_add_api():
    """Add a song to a stored playlist (creating it if it doesn't exist).
    If no file is given, the current song is used."""
    data = request.json or {}
    name = str(data.get("name", "")).strip()
    file_path = str(data.get("file", "")).strip()

    if not name:
        return jsonify({"ok": False, "error": "No playlist name"}), 400

    def run(client):
        target = file_path

        if not target:
            current = client.currentsong() or {}
            target = current.get("file", "")

        if not target:
            return jsonify({
                "ok": False,
                "error": "No current song to add"
            }), 400

        client.playlistadd(name, target)

        return jsonify({"ok": True, "name": name, "file": target})

    return with_mpd(run)


@app.route("/api/playlist")
def playlist_detail_api():
    name = request.args.get("name", "").strip()
    if not name:
        return jsonify({"ok": False, "error": "No playlist name"}), 400

    def run(client):
        tracks = []
        for item in client.listplaylistinfo(name):
            if not isinstance(item, dict):
                continue
            tracks.append({
                "pos": item.get("pos", ""),
                "file": item.get("file", ""),
                "title": item.get("title", ""),
                "artist": item.get("artist", ""),
                "album": item.get("album", ""),
                "duration": item.get("time", item.get("duration", "")),
            })
        return jsonify({"name": name, "tracks": tracks})

    return with_mpd(run)


@app.route("/api/createplaylist", methods=["POST"])
def create_playlist_api():
    name = str((request.json or {}).get("name", "")).strip()
    if not name:
        return jsonify({"ok": False, "error": "No playlist name"}), 400

    def run(client):
        try:
            client.playlistclear(name)
        except Exception:
            pass
        return jsonify({"ok": True, "name": name})

    return with_mpd(run)


@app.route("/api/deleteplaylist", methods=["POST"])
def delete_playlist_api():
    name = str((request.json or {}).get("name", "")).strip()
    if not name:
        return jsonify({"ok": False, "error": "No playlist name"}), 400

    def run(client):
        client.rm(name)
        return jsonify({"ok": True})

    return with_mpd(run)


@app.route("/api/playlistremove", methods=["POST"])
def playlist_remove_api():
    data = request.json or {}
    name = str(data.get("name", "")).strip()
    try:
        pos = int(data.get("pos"))
    except Exception:
        return jsonify({"ok": False, "error": "Invalid position"}), 400

    if not name:
        return jsonify({"ok": False, "error": "No playlist name"}), 400

    def run(client):
        client.playlistdelete(name, pos)
        return jsonify({"ok": True})

    return with_mpd(run)


@app.route("/api/playlistmove", methods=["POST"])
def playlist_move_api():
    data = request.json or {}
    name = str(data.get("name", "")).strip()
    try:
        from_pos = int(data.get("from"))
        to_pos = int(data.get("to"))
    except Exception:
        return jsonify({"ok": False, "error": "Invalid positions"}), 400

    if not name:
        return jsonify({"ok": False, "error": "No playlist name"}), 400

    def run(client):
        client.playlistmove(name, from_pos, to_pos)
        return jsonify({"ok": True})

    return with_mpd(run)


@app.route("/api/renameplaylist", methods=["POST"])
def rename_playlist_api():
    data = request.json or {}
    old_name = str(data.get("old", "")).strip()
    new_name = str(data.get("new", "")).strip()

    if not old_name or not new_name:
        return jsonify({"ok": False, "error": "Both old and new names required"}), 400

    def run(client):
        tracks = client.listplaylistinfo(old_name)
        try:
            client.rm(new_name)
        except Exception:
            pass
        for item in tracks:
            if isinstance(item, dict) and item.get("file"):
                client.playlistadd(new_name, item["file"])
        client.rm(old_name)
        return jsonify({"ok": True, "name": new_name})

    return with_mpd(run)


@app.route("/api/players")
def players_api():
    items = []

    for key, info in PLAYERS.items():
        items.append({
            "key": key,
            "name": info.get("name", key),
            "host": info.get("host", ""),
            "port": info.get("port", 6600)
        })

    return jsonify({"players": items, "current": current_player})


@app.route("/api/player", methods=["POST"])
def set_player_api():
    global current_player

    key = str((request.json or {}).get("key", "")).strip()

    if key not in PLAYERS:
        return jsonify({"ok": False, "error": "Unknown player"}), 400

    current_player = key
    info = PLAYERS[key]
    lib_cache_clear()
    clear_mpd_down()

    return jsonify({"ok": True, "current": key, "name": info.get("name", key)})


@app.route("/api/settings")
def settings_get_api():
    items = []
    for key, info in PLAYERS.items():
        items.append({
            "key": key,
            "name": info.get("name", key),
            "host": info.get("host", ""),
            "port": info.get("port", 6600),
            "password": info.get("password") or "",
            "music_root": info.get("music_root") or "",
        })
    return jsonify({
        "players": items,
        "default_player": DEFAULT_PLAYER,
        "current": current_player,
        "dlna": {
            "public_base": DLNA_CONFIG.get("public_base") or "",
            "selected_udn": DLNA_CONFIG.get("selected_udn") or "",
            "selected_location": DLNA_CONFIG.get("selected_location") or "",
            "selected_name": DLNA_CONFIG.get("selected_name") or "",
        },
        "listenbrainz": {
            "enabled": LISTENBRAINZ_CONFIG.get("enabled"),
            "username": LISTENBRAINZ_CONFIG.get("username") or "",
            "has_token": bool(LISTENBRAINZ_CONFIG.get("token")),
        },
    })


@app.route("/api/settings/players", methods=["POST"])
def settings_save_players_api():
    global PLAYERS, DEFAULT_PLAYER, current_player

    data = request.json or {}
    entries = data.get("players")
    if not isinstance(entries, list) or not entries:
        return jsonify({"ok": False, "error": "No players provided"}), 400

    new_players = {}
    for item in entries:
        if not isinstance(item, dict):
            continue
        key = str(item.get("key", "")).strip()
        if not key:
            key = str(item.get("name", "")).strip().lower().replace(" ", "_")[:32]
        if not key:
            continue
        host = str(item.get("host", "")).strip()
        if not host:
            return jsonify({"ok": False, "error": "Each player needs a host/IP"}), 400
        new_players[key] = normalize_player_entry(item)

    if not new_players:
        return jsonify({"ok": False, "error": "No valid players"}), 400

    default_key = str(data.get("default_player", "")).strip()
    if default_key not in new_players:
        default_key = next(iter(new_players))

    PLAYERS = new_players
    DEFAULT_PLAYER = default_key
    if current_player not in PLAYERS:
        current_player = DEFAULT_PLAYER

    save_config()
    lib_cache_clear()
    return jsonify({"ok": True, "players": list(PLAYERS.keys()), "default_player": DEFAULT_PLAYER})


@app.route("/api/settings/test", methods=["POST"])
def settings_test_api():
    data = request.json or {}
    host = str(data.get("host", "")).strip()
    if not host:
        return jsonify({"ok": False, "error": "Host required"}), 400
    try:
        port = int(data.get("port", 6600))
    except Exception:
        port = 6600
    password = data.get("password") or None
    if password == "":
        password = None

    client = MPDClient()
    client.timeout = 8
    try:
        client.connect(host, port)
        if password:
            client.password(password)
        status = client.status()
        return jsonify({
            "ok": True,
            "state": status.get("state", ""),
            "host": host,
            "port": port,
        })
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 400
    finally:
        try:
            client.close()
            client.disconnect()
        except Exception:
            pass


def sleep_timer_public():
    with _sleep_lock:
        mode = SLEEP_TIMER.get("mode")
        until = SLEEP_TIMER.get("until")
        if not mode:
            return {"active": False, "mode": None, "remaining": None, "minutes": None}
        remaining = None
        if mode == "minutes" and until:
            remaining = max(0, int(until - time.time()))
        return {
            "active": True,
            "mode": mode,
            "until": until,
            "remaining": remaining,
            "minutes": SLEEP_TIMER.get("minutes"),
            "album": SLEEP_TIMER.get("album") or "",
            "albumartist": SLEEP_TIMER.get("albumartist") or "",
        }


def clear_sleep_timer():
    with _sleep_lock:
        SLEEP_TIMER["mode"] = None
        SLEEP_TIMER["until"] = None
        SLEEP_TIMER["minutes"] = None
        SLEEP_TIMER["album"] = ""
        SLEEP_TIMER["albumartist"] = ""


@app.route("/api/status")
def status_api():
    def run(client):
        return jsonify({
            "status": client.status(),
            "song": client.currentsong(),
            "sleep_timer": sleep_timer_public(),
        })

    return with_mpd(run)


@app.route("/api/play", methods=["POST"])
def play_api():
    def run(client):
        client.play()
        return jsonify({"ok": True})

    return with_mpd(run)


@app.route("/api/pause", methods=["POST"])
def pause_api():
    def run(client):
        status = client.status()

        if status.get("state") == "pause":
            client.pause(0)
        else:
            client.pause(1)

        return jsonify({"ok": True})

    return with_mpd(run)


@app.route("/api/stop", methods=["POST"])
def stop_api():
    def run(client):
        client.stop()
        return jsonify({"ok": True})

    return with_mpd(run)


@app.route("/api/next", methods=["POST"])
def next_api():
    def run(client):
        client.next()
        return jsonify({"ok": True})

    return with_mpd(run)


@app.route("/api/previous", methods=["POST"])
def previous_api():
    def run(client):
        client.previous()
        return jsonify({"ok": True})

    return with_mpd(run)


@app.route("/api/random", methods=["POST"])
def random_api():
    def run(client):
        status = client.status()
        current = status.get("random", "0")

        if current == "1":
            client.random(0)
            return jsonify({"ok": True, "random": 0})
        else:
            client.random(1)
            return jsonify({"ok": True, "random": 1})

    return with_mpd(run)


@app.route("/api/crossfade", methods=["GET", "POST"])
def crossfade_api():
    def run(client):
        if request.method == "GET":
            status = client.status() or {}
            return jsonify({
                "xfade": int(float(status.get("xfade") or 0)),
                "mixrampdb": status.get("mixrampdb"),
                "mixrampdelay": status.get("mixrampdelay"),
            })

        data = request.json or {}
        if "seconds" in data:
            seconds = max(0, min(30, int(float(data.get("seconds") or 0))))
            client.crossfade(seconds)
        if "mixrampdb" in data and data.get("mixrampdb") is not None and data.get("mixrampdb") != "":
            client.mixrampdb(float(data.get("mixrampdb")))
        if "mixrampdelay" in data:
            delay = data.get("mixrampdelay")
            if delay is None or delay == "" or str(delay).lower() == "nan":
                client.mixrampdelay("nan")
            else:
                client.mixrampdelay(float(delay))
        if data.get("mixramp") is False:
            try:
                client.mixrampdelay("nan")
            except Exception:
                pass
        status = client.status() or {}
        return jsonify({
            "ok": True,
            "xfade": int(float(status.get("xfade") or 0)),
            "mixrampdb": status.get("mixrampdb"),
            "mixrampdelay": status.get("mixrampdelay"),
        })

    return with_mpd(run)


@app.route("/api/sleeptimer", methods=["GET", "POST"])
def sleep_timer_api():
    if request.method == "GET":
        return jsonify(sleep_timer_public())

    data = request.json or {}
    mode = (data.get("mode") or "").strip().lower()
    if mode in ("", "off", "none", "clear"):
        clear_sleep_timer()
        return jsonify({"ok": True, **sleep_timer_public()})

    if mode == "minutes":
        minutes = max(1, min(180, int(float(data.get("minutes") or 30))))
        with _sleep_lock:
            SLEEP_TIMER["mode"] = "minutes"
            SLEEP_TIMER["until"] = time.time() + minutes * 60
            SLEEP_TIMER["minutes"] = minutes
            SLEEP_TIMER["album"] = ""
            SLEEP_TIMER["albumartist"] = ""
        return jsonify({"ok": True, **sleep_timer_public()})

    if mode == "album":
        album = (data.get("album") or "").strip()
        albumartist = (data.get("albumartist") or "").strip()

        def run(client):
            song = client.currentsong() or {}
            use_album = album or song.get("album") or ""
            use_artist = albumartist or song.get("albumartist") or song.get("artist") or ""
            if not use_album:
                folder = ""
                file_path = song.get("file") or ""
                if file_path and "/" in file_path:
                    folder = "/".join(file_path.split("/")[:-1])
                use_album = folder or file_path or "current"
            with _sleep_lock:
                SLEEP_TIMER["mode"] = "album"
                SLEEP_TIMER["until"] = None
                SLEEP_TIMER["minutes"] = None
                SLEEP_TIMER["album"] = use_album
                SLEEP_TIMER["albumartist"] = use_artist
            return jsonify({"ok": True, **sleep_timer_public()})

        return with_mpd(run)

    return jsonify({"error": "mode must be off, minutes, or album"}), 400


def sleep_timer_loop():
    while True:
        try:
            with _sleep_lock:
                mode = SLEEP_TIMER.get("mode")
                until = SLEEP_TIMER.get("until")
                album = SLEEP_TIMER.get("album") or ""
                albumartist = SLEEP_TIMER.get("albumartist") or ""

            if not mode:
                time.sleep(5)
                continue

            if mode == "minutes" and until and time.time() >= until:
                client = get_mpd()
                try:
                    client.stop()
                finally:
                    try:
                        client.close()
                        client.disconnect()
                    except Exception:
                        pass
                clear_sleep_timer()
            elif mode == "album" and album:
                client = get_mpd()
                try:
                    status = client.status() or {}
                    state = status.get("state", "")
                    song = client.currentsong() or {}
                    if state == "stop":
                        clear_sleep_timer()
                    else:
                        cur_album = song.get("album") or ""
                        cur_artist = song.get("albumartist") or song.get("artist") or ""
                        if not cur_album:
                            file_path = song.get("file") or ""
                            if file_path and "/" in file_path:
                                cur_album = "/".join(file_path.split("/")[:-1])
                            else:
                                cur_album = file_path
                        album_changed = cur_album != album
                        if albumartist and cur_artist and cur_artist != albumartist:
                            album_changed = True
                        if album_changed:
                            client.stop()
                            clear_sleep_timer()
                finally:
                    try:
                        client.close()
                        client.disconnect()
                    except Exception:
                        pass
        except Exception:
            pass
        time.sleep(2)


@app.route("/api/browse")
def browse_api():
    path = request.args.get("path", "")
    cache_key = lib_cache_key("browse", path)
    cached = lib_cache_get(cache_key)
    if cached is not None:
        return jsonify(cached)

    def run(client):
        raw_items = client.lsinfo(path)
        items = []

        for item in raw_items:
            if "directory" in item:
                directory_path = item["directory"]
                name = directory_path.rstrip("/").split("/")[-1]
                items.append({
                    "type": "directory",
                    "name": name,
                    "path": directory_path
                })
            elif "file" in item:
                file_path = item["file"]
                name = file_path.rstrip("/").split("/")[-1]
                items.append({
                    "type": "file",
                    "name": name,
                    "path": file_path,
                    "title": item.get("title", ""),
                    "artist": item.get("artist", ""),
                    "album": item.get("album", ""),
                    "duration": item.get("duration", "")
                })

        lib_cache_set(cache_key, items)
        return jsonify(items)

    def fallback():
        items = browse_from_disk(path)
        lib_cache_set(cache_key, items)
        return jsonify(items)

    return with_mpd_or(run, fallback)


def parse_search_query(query):
    """Parse field:value tokens, e.g. artist:eloy album:rainbow."""
    fields = {}
    rest = []
    for part in query.split():
        if ":" in part:
            key, _, val = part.partition(":")
            key = key.strip().lower()
            val = val.strip()
            if key in ("artist", "album", "title", "genre", "any") and val:
                fields[key] = val
                continue
        rest.append(part)
    free = " ".join(rest).strip()
    return fields, free


def score_track(item, query, fields, free):
    q = query.lower()
    title = (item.get("title") or "").lower()
    artist = (item.get("artist") or "").lower()
    album = (item.get("album") or "").lower()
    genre = (item.get("genre") or "").lower()
    score = 0

    for key, val in fields.items():
        val_l = val.lower()
        if key == "artist" and val_l not in artist:
            return -1
        if key == "album" and val_l not in album:
            return -1
        if key == "title" and val_l not in title:
            return -1
        if key == "genre" and val_l not in genre:
            return -1

    if free:
        fl = free.lower()
        if title == fl:
            score += 100
        elif fl in title:
            score += 60
        if artist == fl:
            score += 50
        elif fl in artist:
            score += 35
        if album == fl:
            score += 40
        elif fl in album:
            score += 25
        if fl in genre:
            score += 20
        if score == 0 and fl not in title and fl not in artist and fl not in album:
            return -1
    elif fields:
        score = 10

    return score


def collect_search_tracks(client, query, search_type):
    fields, free = parse_search_query(query)
    results = None

    if search_type == "any" and not fields:
        low = query.lower()
        idx = low.rfind(" by ")
        if idx != -1:
            title_part = query[:idx].strip()
            artist_part = query[idx + 4:].strip()
            if title_part and artist_part:
                try:
                    results = client.search("title", title_part, "artist", artist_part)
                except Exception:
                    results = None

    if results is None:
        if fields:
            args = []
            for key in ("artist", "album", "title", "genre"):
                if key in fields:
                    args.extend([key, fields[key]])
            if args:
                try:
                    results = client.search(*args)
                except Exception:
                    results = []
            elif free:
                results = client.search("any", free)
            else:
                results = []
        elif search_type == "any":
            seen = {}
            for stype in ("title", "artist", "album"):
                try:
                    for item in client.search(stype, query):
                        if isinstance(item, dict) and item.get("file"):
                            seen[item["file"]] = item
                except Exception:
                    pass
            results = list(seen.values())
        else:
            results = client.search(search_type, query)

    clean = []
    for item in results or []:
        if not isinstance(item, dict) or "file" not in item:
            continue
        track = {
            "file": item.get("file", ""),
            "title": item.get("title", ""),
            "artist": item.get("artist", ""),
            "album": item.get("album", ""),
            "albumartist": item.get("albumartist", ""),
            "genre": item.get("genre", ""),
            "date": item.get("date", ""),
            "duration": item.get("duration", ""),
        }
        sc = score_track(track, query, fields, free)
        if sc >= 0:
            track["_score"] = sc
            clean.append(track)

    clean.sort(key=lambda x: x.get("_score", 0), reverse=True)
    for t in clean:
        t.pop("_score", None)
    return clean


@app.route("/api/search")
def search_api():
    query = request.args.get("q", "").strip()
    search_type = request.args.get("type", "any").lower()
    mode = request.args.get("mode", "tracks").lower()

    allowed = ["any", "artist", "album", "title", "genre"]
    if search_type not in allowed:
        search_type = "any"

    try:
        limit = int(request.args.get("limit", 20))
    except Exception:
        limit = 20
    try:
        offset = int(request.args.get("offset", 0))
    except Exception:
        offset = 0

    limit = max(1, min(limit, 200))
    offset = max(0, offset)

    if not query:
        return jsonify({"mode": mode, "total": 0, "results": []})

    def run(client):
        if mode == "albums":
            tracks = collect_search_tracks(client, query, search_type)
            albums = {}
            for t in tracks:
                key = (t.get("album", ""), t.get("albumartist") or t.get("artist", ""))
                if not key[0]:
                    continue
                if key not in albums:
                    albums[key] = {
                        "album": key[0],
                        "albumartist": key[1],
                        "track_count": 0,
                        "year": t.get("date", ""),
                    }
                albums[key]["track_count"] += 1
            results = sorted(albums.values(), key=lambda a: a["album"].lower())
            total = len(results)
            return jsonify({
                "mode": "albums",
                "total": total,
                "results": results[offset:offset + limit],
            })

        if mode == "artists":
            tracks = collect_search_tracks(client, query, search_type)
            artists = {}
            for t in tracks:
                name = (t.get("artist") or "").strip()
                if not name:
                    continue
                if name not in artists:
                    artists[name] = {"artist": name, "track_count": 0}
                artists[name]["track_count"] += 1
            results = sorted(artists.values(), key=lambda a: a["artist"].lower())
            total = len(results)
            return jsonify({
                "mode": "artists",
                "total": total,
                "results": results[offset:offset + limit],
            })

        tracks = collect_search_tracks(client, query, search_type)
        total = len(tracks)
        return jsonify({
            "mode": "tracks",
            "total": total,
            "results": tracks[offset:offset + limit],
        })

    def fallback():
        if mode == "albums":
            tracks = disk_search_tracks(query, search_type)
            albums = {}
            for t in tracks:
                key = (t.get("album", ""), t.get("albumartist") or t.get("artist", ""))
                if not key[0]:
                    continue
                if key not in albums:
                    albums[key] = {
                        "album": key[0],
                        "albumartist": key[1],
                        "track_count": 0,
                        "year": t.get("date", ""),
                    }
                albums[key]["track_count"] += 1
            results = sorted(albums.values(), key=lambda a: a["album"].lower())
            total = len(results)
            return jsonify({
                "mode": "albums",
                "total": total,
                "results": results[offset:offset + limit],
            })

        if mode == "artists":
            tracks = disk_search_tracks(query, search_type)
            artists = {}
            for t in tracks:
                name = (t.get("artist") or "").strip()
                if not name:
                    continue
                if name not in artists:
                    artists[name] = {"artist": name, "track_count": 0}
                artists[name]["track_count"] += 1
            results = sorted(artists.values(), key=lambda a: a["artist"].lower())
            total = len(results)
            return jsonify({
                "mode": "artists",
                "total": total,
                "results": results[offset:offset + limit],
            })

        tracks = disk_search_tracks(query, search_type)
        total = len(tracks)
        return jsonify({
            "mode": "tracks",
            "total": total,
            "results": tracks[offset:offset + limit],
        })

    return with_mpd_or(run, fallback, timeout=15)

@app.route("/api/add", methods=["POST"])
def add_api():
    path = request.json.get("path", "")

    if not path:
        return jsonify({"ok": False, "error": "No path"}), 400

    def run(client):
        client.add(path)
        return jsonify({"ok": True})

    return with_mpd(run)


@app.route("/api/playpath", methods=["POST"])
def play_path_api():
    path = request.json.get("path", "")

    if not path:
        return jsonify({"ok": False, "error": "No path"}), 400

    def run(client):
        client.clear()
        client.add(path)
        client.play()
        return jsonify({"ok": True})

    return with_mpd(run)


@app.route("/api/foldertracks")
def folder_tracks_api():
    """Recursive file list for a folder path (includes subfolders)."""
    path = request.args.get("path", "").strip()
    try:
        limit = int(request.args.get("limit", 500))
    except Exception:
        limit = 500
    limit = max(1, min(limit, 2000))

    if not path:
        return jsonify({"ok": False, "error": "No path", "tracks": []}), 400

    def run(client):
        tracks = list_folder_tracks(client, path, limit=limit)
        return jsonify({"ok": True, "tracks": tracks, "total": len(tracks)})

    def fallback():
        tracks = list_folder_tracks_from_disk(path, limit=limit)
        return jsonify({"ok": True, "tracks": tracks, "total": len(tracks), "source": "disk"})

    return with_mpd_or(run, fallback, timeout=30)


@app.route("/api/queue")
def queue_api():
    def run(client):
        status = client.status()
        current_id = status.get("songid", "")

        playlist = client.playlistinfo()
        queue = []

        for item in playlist:
            if not isinstance(item, dict):
                continue

            queue.append({
                "id": item.get("id", ""),
                "pos": item.get("pos", ""),
                "file": item.get("file", ""),
                "title": item.get("title", ""),
                "artist": item.get("artist", ""),
                "album": item.get("album", ""),
                "duration": item.get("duration", "")
            })

        return jsonify({
            "current_id": current_id,
            "queue": queue
        })

    return with_mpd(run)


@app.route("/api/playqueue", methods=["POST"])
def play_queue_api():
    song_id = str(request.json.get("id", "")).strip()

    if not song_id:
        return jsonify({"ok": False, "error": "No queue item id"}), 400

    def run(client):
        client.playid(song_id)
        return jsonify({"ok": True, "id": song_id})

    return with_mpd(run)


@app.route("/api/removequeue", methods=["POST"])
def remove_queue_api():
    song_id = str(request.json.get("id", "")).strip()

    if not song_id:
        return jsonify({"ok": False, "error": "No queue item id"}), 400

    def run(client):
        client.deleteid(song_id)
        return jsonify({"ok": True, "id": song_id})

    return with_mpd(run)


@app.route("/api/clearqueue", methods=["POST"])
def clear_queue_api():
    def run(client):
        client.clear()
        return jsonify({"ok": True})

    return with_mpd(run)


@app.route("/api/movequeue", methods=["POST"])
def move_queue_api():
    data = request.json or {}
    try:
        from_pos = int(data.get("from"))
        to_pos = int(data.get("to"))
    except Exception:
        return jsonify({"ok": False, "error": "from and to positions required"}), 400

    def run(client):
        playlist = client.playlistinfo()
        n = len(playlist) if playlist else 0
        if n <= 0:
            return jsonify({"ok": False, "error": "Queue empty"}), 400
        if from_pos < 0 or from_pos >= n or to_pos < 0 or to_pos >= n:
            return jsonify({"ok": False, "error": "Position out of range"}), 400
        if from_pos != to_pos:
            client.move(from_pos, to_pos)
        return jsonify({"ok": True, "from": from_pos, "to": to_pos})

    return with_mpd(run)


def get_seed_song(client):
    """Current song, or the last queued track if nothing is playing."""
    seed = client.currentsong() or {}
    if not seed:
        playlist = client.playlistinfo()
        if playlist:
            seed = playlist[-1]
    return seed


def get_seed_song_or_file(client, seed_file=""):
    """Prefer an explicit file (browser mode), else currentsong/queue."""
    seed_file = (seed_file or "").strip()
    if seed_file:
        try:
            info = client.lsinfo(seed_file)
            if isinstance(info, list):
                for item in info:
                    if isinstance(item, dict) and item.get("file") == seed_file:
                        return item
                    if isinstance(item, dict) and item.get("file"):
                        return item
            elif isinstance(info, dict) and info.get("file"):
                return info
        except Exception:
            pass
        return {"file": seed_file}
    return get_seed_song(client)


def queued_files(client):
    files = set()
    for item in client.playlistinfo():
        if isinstance(item, dict) and item.get("file"):
            files.add(item["file"])
    return files


def track_payload(item):
    if not isinstance(item, dict) or not item.get("file"):
        return None
    return {
        "file": item.get("file", ""),
        "title": item.get("title", ""),
        "artist": item.get("artist", ""),
        "album": item.get("album", ""),
        "albumartist": item.get("albumartist", ""),
    }


def list_folder_tracks(client, path, limit=500):
    """Recursively list audio files under path (MPD listallinfo)."""
    path = (path or "").strip()
    tracks = []
    try:
        raw = client.listallinfo(path) if path else []
    except Exception:
        raw = []
        try:
            raw = client.lsinfo(path)
        except Exception:
            raw = []

    for item in raw or []:
        payload = track_payload(item)
        if payload:
            tracks.append(payload)
        if len(tracks) >= limit:
            break
    return tracks


def pick_varied(pool, count, max_per_artist=2, max_per_album=1):
    """Pick up to `count` tracks from pool, capping repeats per artist/album."""
    chosen = []
    chosen_files = set()
    per_artist = {}
    per_album = {}

    for t in pool:
        f = t.get("file", "")
        if not f or f in chosen_files:
            continue
        artist_key = (t.get("artist") or t.get("albumartist") or "").lower()
        album_key = (t.get("album") or "").lower()
        if artist_key and per_artist.get(artist_key, 0) >= max_per_artist:
            continue
        if album_key and per_album.get(album_key, 0) >= max_per_album:
            continue
        if artist_key:
            per_artist[artist_key] = per_artist.get(artist_key, 0) + 1
        if album_key:
            per_album[album_key] = per_album.get(album_key, 0) + 1
        chosen.append(t)
        chosen_files.add(f)
        if len(chosen) >= count:
            break

    if len(chosen) < count:
        for t in pool:
            f = t.get("file", "")
            if not f or f in chosen_files:
                continue
            chosen.append(t)
            chosen_files.add(f)
            if len(chosen) >= count:
                break

    return chosen


def score_similar_track(track, seed):
    """Higher score = better radio match for the seed song."""
    score = random.random() * 4  # small jitter for variety

    seed_genre = (seed.get("genre") or "").lower()
    seed_artist = (seed.get("artist") or "").lower()
    seed_albumartist = (seed.get("albumartist") or seed.get("artist") or "").lower()
    seed_album = (seed.get("album") or "").lower()
    seed_date = (seed.get("date") or "")[:4]

    genre = (track.get("genre") or "").lower()
    artist = (track.get("artist") or "").lower()
    albumartist = (track.get("albumartist") or track.get("artist") or "").lower()
    album = (track.get("album") or "").lower()
    date = (track.get("date") or "")[:4]

    if seed_genre and genre and seed_genre == genre:
        score += 35
    elif seed_genre and genre and seed_genre in genre:
        score += 18

    if seed_artist and artist and seed_artist == artist:
        score += 22

    if seed_albumartist and albumartist and seed_albumartist == albumartist:
        score += 16

    if seed_album and album and seed_album != album and albumartist == seed_albumartist:
        score += 10  # same act, different album

    if seed_date and date and seed_date == date:
        score += 6

    return score


def radio_seed_song(client):
    """Prefer the last queued track so radio evolves; fall back to now playing."""
    playlist = client.playlistinfo()
    if playlist:
        last = playlist[-1]
        if isinstance(last, dict) and last.get("file"):
            return last
    return get_seed_song(client)


def folder_neighbor_tracks(client, seed_file, in_queue, limit=60):
    """Fast fallback: other tracks in the same folder tree (no listall)."""
    if not seed_file or "/" not in seed_file:
        return []

    parts = seed_file.split("/")
    pool = []
    seen = set()

    # Walk up to 3 parent folders looking for siblings.
    for depth in range(len(parts) - 1, max(-1, len(parts) - 4), -1):
        folder = "/".join(parts[:depth]) if depth > 0 else ""
        try:
            items = client.lsinfo(folder)
        except Exception:
            continue

        for item in items or []:
            if not isinstance(item, dict):
                continue
            f = item.get("file", "")
            if not f or f in seen or f in in_queue or f == seed_file:
                continue
            seen.add(f)
            pool.append(item)
            if len(pool) >= limit:
                return pool

    return pool


def local_similar_tracks(client, seed, count, in_queue):
    """Build a scored 'radio' pool from the local library."""
    seed_file = seed.get("file", "")
    seed_artist = (seed.get("artist") or "").strip()
    seed_albumartist = (seed.get("albumartist") or seed_artist).strip()
    seed_genre = (seed.get("genre") or "").strip()

    def find_tracks(*args):
        out = []
        try:
            for item in client.find(*args):
                if isinstance(item, dict) and item.get("file"):
                    out.append(item)
        except Exception:
            pass
        return out

    candidates = []
    if seed_genre:
        candidates += find_tracks("genre", seed_genre)
    if seed_albumartist:
        candidates += find_tracks("albumartist", seed_albumartist)
    if seed_artist and seed_artist != seed_albumartist:
        candidates += find_tracks("artist", seed_artist)

    seen = set()
    pool = []

    for t in candidates:
        f = t.get("file", "")
        if not f or f in seen or f in in_queue or f == seed_file:
            continue
        seen.add(f)
        pool.append(t)

    if len(pool) < count:
        for t in folder_neighbor_tracks(client, seed_file, in_queue):
            f = t.get("file", "")
            if not f or f in seen or f in in_queue or f == seed_file:
                continue
            seen.add(f)
            pool.append(t)
            if len(pool) >= count * 4:
                break

    # Last resort: sample a couple of genres (fast), never listall().
    if len(pool) < count:
        try:
            genres = client.list("genre")
            random.shuffle(genres)
            for g in genres[:4]:
                gv = g.get("genre") if isinstance(g, dict) else str(g)
                gv = (gv or "").strip()
                if not gv:
                    continue
                for item in find_tracks("genre", gv)[:25]:
                    f = item.get("file", "")
                    if not f or f in seen or f in in_queue or f == seed_file:
                        continue
                    seen.add(f)
                    pool.append(item)
                    if len(pool) >= count * 4:
                        break
                if len(pool) >= count * 4:
                    break
        except Exception:
            pass

    if not pool:
        return []

    pool.sort(key=lambda t: score_similar_track(t, seed), reverse=True)
    chosen = pick_varied(pool, count, max_per_artist=2, max_per_album=1)
    if not chosen and pool:
        chosen = pool[:count]
    return chosen


def seed_from_disk(seed_file):
    """Build a seed song dict from a library path (no MPD)."""
    seed_file = (seed_file or "").strip()
    if not seed_file:
        return {}
    tags = infer_tags_from_path(seed_file)
    # Prefer metadata from recent plays when available.
    try:
        for item in load_recent_plays():
            if isinstance(item, dict) and item.get("file") == seed_file:
                return {
                    "file": seed_file,
                    "title": item.get("title") or tags.get("title", ""),
                    "artist": item.get("artist") or tags.get("artist", ""),
                    "album": item.get("album") or tags.get("album", ""),
                    "albumartist": item.get("albumartist") or tags.get("albumartist", ""),
                    "genre": item.get("genre") or "",
                    "date": item.get("date") or "",
                }
    except Exception:
        pass
    return {
        "file": seed_file,
        "title": tags.get("title", ""),
        "artist": tags.get("artist", ""),
        "album": tags.get("album", ""),
        "albumartist": tags.get("albumartist", ""),
        "genre": "",
        "date": "",
    }


def folder_neighbor_tracks_from_disk(seed_file, in_queue, limit=80):
    """Other tracks near the seed path on disk."""
    if not seed_file or "/" not in seed_file:
        return []
    parts = seed_file.split("/")
    pool = []
    seen = set()
    for depth in range(len(parts) - 1, max(-1, len(parts) - 4), -1):
        folder = "/".join(parts[:depth]) if depth > 0 else ""
        try:
            tracks = list_folder_tracks_from_disk(folder, limit=max(limit * 2, 40))
        except Exception:
            continue
        for item in tracks:
            f = item.get("file", "")
            if not f or f in seen or f in in_queue or f == seed_file:
                continue
            seen.add(f)
            pool.append(item)
            if len(pool) >= limit:
                return pool
    return pool


def disk_tracks_for_artist(artist_name, limit=80):
    """Collect tracks for an artist from the disk album index."""
    artist_name = (artist_name or "").strip()
    if not artist_name:
        return []
    lib = get_disk_library()
    al = artist_name.lower()
    out = []
    seen = set()
    album_hits = []
    for a in lib.get("albums") or []:
        aa = (a.get("albumartist") or "").strip()
        aa_l = aa.lower()
        if aa_l == al or al in aa_l or aa_l in al:
            album_hits.append(a)
    # Prefer exact albumartist matches first.
    album_hits.sort(key=lambda a: 0 if (a.get("albumartist") or "").lower() == al else 1)

    for a in album_hits[:20]:
        aa = a.get("albumartist") or artist_name
        for t in disk_album_tracks(a.get("album") or "", aa)[:30]:
            f = t.get("file")
            if not f or f in seen:
                continue
            seen.add(f)
            out.append({
                "file": f,
                "title": t.get("title", ""),
                "artist": t.get("artist", "") or aa,
                "album": t.get("album", "") or a.get("album", ""),
                "albumartist": aa,
                "genre": "",
                "date": "",
            })
            if len(out) >= limit:
                return out
    return out


def local_similar_tracks_from_disk(seed, count, in_queue):
    """Disk-only similar/radio pool (browser mode when MPD is offline)."""
    seed_file = seed.get("file", "")
    seed_artist = (seed.get("artist") or "").strip()
    seed_albumartist = (seed.get("albumartist") or seed_artist).strip()

    seen = set()
    pool = []

    for artist in (seed_albumartist, seed_artist):
        if not artist:
            continue
        for t in disk_tracks_for_artist(artist, limit=count * 8):
            f = t.get("file", "")
            if not f or f in seen or f in in_queue or f == seed_file:
                continue
            seen.add(f)
            pool.append(t)

    if len(pool) < count:
        for t in folder_neighbor_tracks_from_disk(seed_file, in_queue, limit=count * 10):
            f = t.get("file", "")
            if not f or f in seen or f in in_queue or f == seed_file:
                continue
            seen.add(f)
            pool.append(t)

    # Broaden to other folders in the same top-level category.
    if len(pool) < count and seed_file and "/" in seed_file:
        top = seed_file.split("/")[0]
        try:
            items = browse_from_disk(top)
            dirs = [i for i in items if i.get("type") == "directory"]
            random.shuffle(dirs)
            for d in dirs[:10]:
                try:
                    tracks = list_folder_tracks_from_disk(d.get("path") or "", limit=25)
                except Exception:
                    continue
                for t in tracks:
                    f = t.get("file", "")
                    if not f or f in seen or f in in_queue or f == seed_file:
                        continue
                    seen.add(f)
                    pool.append(t)
                    if len(pool) >= count * 5:
                        break
                if len(pool) >= count * 5:
                    break
        except Exception:
            pass

    if not pool:
        return []

    pool.sort(key=lambda t: score_similar_track(t, seed), reverse=True)
    chosen = pick_varied(pool, count, max_per_artist=2, max_per_album=1)
    if not chosen and pool:
        chosen = pool[:count]
    return chosen


def match_disk_artists(names, limit=20):
    """Map online similar-artist names to artists present on disk."""
    lib = get_disk_library()
    artist_set = {a.lower(): a for a in (lib.get("artists") or [])}
    matched = []
    seen = set()
    for name in names or []:
        name = (name or "").strip()
        if not name:
            continue
        key = name.lower()
        hit = None
        if key in artist_set:
            hit = artist_set[key]
        else:
            for al, orig in artist_set.items():
                if key in al or al in key:
                    hit = orig
                    break
        if hit and hit.lower() not in seen:
            seen.add(hit.lower())
            matched.append(hit)
            if len(matched) >= limit:
                break
    return matched


def _queue_radio_tracks_disk(seed, count, in_queue, mode):
    """Smart/local radio picking using disk library (+ ListenBrainz for smart)."""
    seed_artist = (seed.get("artist") or "").strip()
    seed_file = seed.get("file", "")

    if mode == "smart":
        debug = {"source": "disk"}
        matched_artists = []
        if seed_artist:
            mbid = musicbrainz_artist_mbid(seed_artist, debug)
            similar_names = listenbrainz_similar_artists(mbid, debug)
            matched_artists = match_disk_artists(similar_names, limit=20)
        debug["library_matches"] = len(matched_artists)

        chosen = []
        source = "listenbrainz"
        if matched_artists:
            tracks = []
            for artist in matched_artists:
                for item in disk_tracks_for_artist(artist, limit=40):
                    f = item.get("file", "")
                    if not f or f in in_queue or f == seed_file:
                        continue
                    tracks.append(item)
                if len(tracks) >= count * 6:
                    break
            tracks.sort(key=lambda t: score_similar_track(t, seed), reverse=True)
            chosen = pick_varied(tracks, count, max_per_artist=2, max_per_album=1)
            if not chosen and tracks:
                chosen = tracks[:count]

        if not chosen:
            source = "local-disk"
            chosen = local_similar_tracks_from_disk(seed, count, in_queue)
        return chosen, source, debug, matched_artists[:10]

    chosen = local_similar_tracks_from_disk(seed, count, in_queue)
    return chosen, "local-disk", {"source": "disk"}, []


def browser_radio_fallback(seed_file, exclude, count, mode="local"):
    """Shared browser-mode response when MPD is offline."""
    seed = seed_from_disk(seed_file)
    if not seed.get("file"):
        return jsonify({
            "ok": False,
            "error": "Nothing playing to seed radio — play a track first"
        }), 400

    in_queue = set(str(x) for x in (exclude or []) if x)
    in_queue.add(seed["file"])

    if mode == "similar":
        chosen = local_similar_tracks_from_disk(seed, count, in_queue)
        source = "local-disk"
        debug = {"source": "disk"}
        artists = []
    else:
        chosen, source, debug, artists = _queue_radio_tracks_disk(
            seed, count, in_queue, mode
        )

    if not chosen:
        return jsonify({
            "ok": False,
            "error": "No matching tracks found on disk for this seed"
        }), 404

    tracks = [t for t in (track_payload(x) for x in chosen) if t]
    return jsonify({
        "ok": True,
        "added": len(tracks),
        "tracks": tracks,
        "source": source,
        "mode": mode,
        "browser": True,
        "seed_artist": (seed.get("artist") or "").strip(),
        "seed_title": (seed.get("title") or "").strip(),
        "artists": artists,
        "debug": debug,
    })
    """Returns (data, error_string). error_string is None on success."""
    req = urllib.request.Request(
        url, headers={"User-Agent": SMART_RADIO_USER_AGENT}
    )

    def attempt(context=None):
        with urllib.request.urlopen(req, timeout=timeout, context=context) as resp:
            return json.loads(resp.read().decode("utf-8", "replace"))

    try:
        return attempt(), None
    except urllib.error.HTTPError as e:
        return None, "HTTP %s" % e.code
    except urllib.error.URLError as e:
        reason = str(getattr(e, "reason", e))
        # Common on older Raspberry Pi installs: outdated CA store. Retry once
        # without certificate verification (these are public read-only APIs).
        if "SSL" in reason.upper() or "CERTIFICATE" in reason.upper():
            try:
                return attempt(context=ssl._create_unverified_context()), None
            except Exception as e2:
                return None, "SSL retry failed: %s" % e2
        return None, "Network error: %s" % reason
    except Exception as e:
        return None, "Error: %s" % e


def _http_get_json(url, timeout=8):
    """Returns (data, error_string). error_string is None on success."""
    req = urllib.request.Request(
        url, headers={"User-Agent": SMART_RADIO_USER_AGENT}
    )

    def attempt(context=None):
        with urllib.request.urlopen(req, timeout=timeout, context=context) as resp:
            return json.loads(resp.read().decode("utf-8", "replace"))

    try:
        return attempt(), None
    except urllib.error.HTTPError as e:
        return None, "HTTP %s" % e.code
    except urllib.error.URLError as e:
        reason = str(getattr(e, "reason", e))
        # Common on older Raspberry Pi installs: outdated CA store. Retry once
        # without certificate verification (these are public read-only APIs).
        if "SSL" in reason.upper() or "CERTIFICATE" in reason.upper():
            try:
                return attempt(context=ssl._create_unverified_context()), None
            except Exception as e2:
                return None, "SSL retry failed: %s" % e2
        return None, "Network error: %s" % reason
    except Exception as e:
        return None, "Error: %s" % e


def musicbrainz_artist_mbid(name, debug):
    """Resolve an artist name to its MusicBrainz ID (or None)."""
    if not name:
        debug["musicbrainz"] = "no seed artist"
        return None

    url = "https://musicbrainz.org/ws/2/artist/?" + urllib.parse.urlencode({
        "query": 'artist:"%s"' % name,
        "fmt": "json",
        "limit": 1,
    })

    data, err = _http_get_json(url)
    if err:
        debug["musicbrainz"] = err
        return None

    artists = data.get("artists") if isinstance(data, dict) else None
    if artists:
        debug["musicbrainz"] = "ok"
        return artists[0].get("id")

    debug["musicbrainz"] = "no artist match"
    return None


def listenbrainz_similar_artists(mbid, debug):
    """Return a list of artist names similar to the given MBID, best first."""
    if not mbid:
        debug["listenbrainz"] = "skipped (no mbid)"
        return []

    url = "https://labs.api.listenbrainz.org/similar-artists/json?" + \
        urllib.parse.urlencode({
            "artist_mbids": mbid,
            "algorithm": LB_ALGORITHM,
        })

    data, err = _http_get_json(url)
    if err:
        debug["listenbrainz"] = err
        return []

    # Response is usually a list of artist dicts; tolerate a few wrappings.
    items = data
    if isinstance(data, dict):
        items = data.get("payload") or data.get("artists") or []
        if isinstance(items, dict):
            items = items.get("artists") or []

    scored = []
    if isinstance(items, list):
        for it in items:
            if not isinstance(it, dict):
                continue
            name = (it.get("name") or it.get("artist_name") or "").strip()
            if not name:
                continue
            try:
                score = float(it.get("score", 0) or 0)
            except Exception:
                score = 0
            scored.append((name, score))

    scored.sort(key=lambda x: x[1], reverse=True)
    debug["listenbrainz"] = "ok (%d similar)" % len(scored)
    return [name for name, _ in scored]


@app.route("/api/similar", methods=["POST"])
def similar_api():
    """Local 'radio': append tracks similar to the current song, picked from
    the local library by genre/artist tags. No external services.
    browser=true returns tracks without changing the MPD queue."""
    data = request.json or {}

    try:
        count = int(data.get("count", 10))
    except Exception:
        count = 10

    count = max(1, min(count, 50))
    browser = bool(data.get("browser", False))
    seed_file = str(data.get("seed_file", "") or "").strip()
    exclude = data.get("exclude") or []
    if not isinstance(exclude, list):
        exclude = []

    def run(client):
        seed = get_seed_song_or_file(client, seed_file)
        if not seed or not seed.get("file"):
            return jsonify({
                "ok": False,
                "error": "Nothing playing to base suggestions on"
            }), 400

        in_queue = set(str(x) for x in exclude if x) if browser else queued_files(client)
        if seed.get("file"):
            in_queue.add(seed["file"])
        chosen = local_similar_tracks(client, seed, count, in_queue)
        tracks = [t for t in (track_payload(x) for x in chosen) if t]

        if not browser:
            for t in chosen:
                client.add(t["file"])

        return jsonify({
            "ok": True,
            "added": len(tracks),
            "tracks": tracks,
            "browser": browser,
            "seed_artist": (seed.get("artist") or "").strip(),
            "seed_genre": (seed.get("genre") or "").strip()
        })

    def fallback():
        if not browser:
            return jsonify({
                "ok": False,
                "error": "MPD player is offline or unreachable"
            }), 503
        return browser_radio_fallback(seed_file, exclude, count, mode="similar")

    if browser:
        return with_mpd_or(run, fallback, timeout=30)
    return with_mpd(run)


@app.route("/api/smartradio", methods=["POST"])
def smart_radio_api():
    """Online 'smart radio'… Falls back to local similarity.
    browser=true returns tracks without changing the MPD queue."""
    data = request.json or {}

    try:
        count = int(data.get("count", 10))
    except Exception:
        count = 10

    count = max(1, min(count, 50))
    browser = bool(data.get("browser", False))
    seed_file = str(data.get("seed_file", "") or "").strip()
    exclude = data.get("exclude") or []
    if not isinstance(exclude, list):
        exclude = []

    def run(client):
        seed = get_seed_song_or_file(client, seed_file)
        if not seed or not seed.get("file"):
            return jsonify({
                "ok": False,
                "error": "Nothing playing to base suggestions on"
            }), 400

        in_queue = set(str(x) for x in exclude if x) if browser else queued_files(client)
        if seed.get("file"):
            in_queue.add(seed["file"])

        chosen, source, debug, matched_artists = _queue_radio_tracks(
            client, seed, count, in_queue, "smart"
        )
        tracks = [t for t in (track_payload(x) for x in chosen) if t]

        if not browser:
            for t in chosen:
                client.add(t["file"])

        return jsonify({
            "ok": True,
            "added": len(tracks),
            "tracks": tracks,
            "source": source,
            "browser": browser,
            "seed_artist": (seed.get("artist") or "").strip(),
            "artists": matched_artists[:10],
            "debug": debug
        })

    def fallback():
        if not browser:
            return jsonify({
                "ok": False,
                "error": "MPD player is offline or unreachable"
            }), 503
        return browser_radio_fallback(seed_file, exclude, count, mode="smart")

    if browser:
        return with_mpd_or(run, fallback, timeout=60)
    return with_mpd(run, timeout=60)


def _queue_radio_tracks(client, seed, count, in_queue, mode):
    """Shared logic for smart/local radio track picking."""
    seed_artist = (seed.get("artist") or "").strip()
    seed_file = seed.get("file", "")

    if mode == "smart":
        debug = {}
        matched_artists = []

        if seed_artist:
            mbid = musicbrainz_artist_mbid(seed_artist, debug)
            similar_names = listenbrainz_similar_artists(mbid, debug)
            # Discover owned artists by searching — skip slow list("artist").
            for name in similar_names[:20]:
                try:
                    found = client.find("artist", name)
                    if found:
                        matched_artists.append(name)
                except Exception:
                    pass
        debug["library_matches"] = len(matched_artists)

        chosen = []
        source = "listenbrainz"
        if matched_artists:
            tracks = []
            for artist in matched_artists:
                try:
                    for item in client.find("artist", artist):
                        if not isinstance(item, dict):
                            continue
                        f = item.get("file", "")
                        if not f or f in in_queue or f == seed_file:
                            continue
                        tracks.append(item)
                except Exception:
                    pass
                if len(tracks) >= count * 6:
                    break

            tracks.sort(key=lambda t: score_similar_track(t, seed), reverse=True)
            chosen = pick_varied(tracks, count, max_per_artist=2, max_per_album=1)
            if not chosen and tracks:
                chosen = tracks[:count]

        if not chosen:
            source = "local"
            chosen = local_similar_tracks(client, seed, count, in_queue)

        return chosen, source, debug, matched_artists[:10]

    chosen = local_similar_tracks(client, seed, count, in_queue)
    return chosen, "local", {}, []


@app.route("/api/radio/start", methods=["POST"])
def radio_start_api():
    """Start a radio session: queue similar tracks, shuffle on, auto-radio on.
    With browser=true, return tracks only (no MPD queue / auto-radio changes)."""
    data = request.json or {}
    mode = str(data.get("mode", "local")).lower()
    if mode not in ("local", "smart"):
        mode = "local"
    try:
        count = int(data.get("count", 15))
    except Exception:
        count = 15
    count = max(5, min(count, 50))
    replace = bool(data.get("replace", False))
    browser = bool(data.get("browser", False))
    seed_file = str(data.get("seed_file", "") or "").strip()
    exclude = data.get("exclude") or []
    if not isinstance(exclude, list):
        exclude = []

    def run(client):
        global AUTO_RADIO_ENABLED

        seed = get_seed_song_or_file(client, seed_file)
        if not seed or not seed.get("file"):
            return jsonify({
                "ok": False,
                "error": "Nothing playing to seed radio — play a track first"
            }), 400

        in_queue = set(str(x) for x in exclude if x) if browser else queued_files(client)
        if seed.get("file"):
            in_queue.add(seed["file"])

        chosen, source, debug, artists = _queue_radio_tracks(
            client, seed, count, in_queue, mode
        )

        if not chosen:
            return jsonify({
                "ok": False,
                "error": "No matching tracks found — try playing a tagged song (artist/genre) first"
            }), 404

        tracks = [track_payload(t) for t in chosen]
        tracks = [t for t in tracks if t]

        if browser:
            return jsonify({
                "ok": True,
                "added": len(tracks),
                "tracks": tracks,
                "source": source,
                "mode": mode,
                "browser": True,
                "seed_artist": (seed.get("artist") or "").strip(),
                "artists": artists,
            })

        if replace:
            client.clear()

        for t in chosen:
            client.add(t["file"])

        client.random(1)
        status = client.status()
        if status.get("state") != "play":
            client.play()

        AUTO_RADIO_ENABLED = True

        return jsonify({
            "ok": True,
            "added": len(chosen),
            "tracks": tracks,
            "source": source,
            "mode": mode,
            "auto_radio": True,
            "seed_artist": (seed.get("artist") or "").strip(),
            "seed_title": (seed.get("title") or "").strip(),
            "artists": artists,
            "debug": debug,
        })

    def fallback():
        if not browser:
            return jsonify({
                "ok": False,
                "error": "MPD player is offline or unreachable"
            }), 503
        return browser_radio_fallback(seed_file, exclude, count, mode=mode)

    if browser:
        return with_mpd_or(run, fallback, timeout=60)
    return with_mpd(run, timeout=60)


@app.route("/api/radio/stop", methods=["POST"])
def radio_stop_api():
    global AUTO_RADIO_ENABLED
    AUTO_RADIO_ENABLED = False
    return jsonify({"ok": True, "auto_radio": False})


@app.route("/api/radio/status")
def radio_status_api():
    return jsonify({
        "auto_radio": AUTO_RADIO_ENABLED,
        "threshold": AUTO_RADIO_THRESHOLD,
        "batch": AUTO_RADIO_BATCH,
    })


@app.route("/api/autoradio")
def auto_radio_get():
    return jsonify({
        "enabled": AUTO_RADIO_ENABLED,
        "threshold": AUTO_RADIO_THRESHOLD
    })


@app.route("/api/autoradio", methods=["POST"])
def auto_radio_set():
    global AUTO_RADIO_ENABLED
    data = request.json or {}
    AUTO_RADIO_ENABLED = bool(data.get("enabled"))
    return jsonify({"ok": True, "enabled": AUTO_RADIO_ENABLED})


def auto_radio_loop():
    """Background worker: while enabled, keep the queue topped up from the
    local library whenever fewer than AUTO_RADIO_THRESHOLD songs remain."""
    while True:
        try:
            if AUTO_RADIO_ENABLED:
                client = get_mpd()
                try:
                    status = client.status()
                    state = status.get("state", "")
                    length = int(status.get("playlistlength", 0) or 0)
                    song = status.get("song")

                    if song is None:
                        upcoming = 0
                    else:
                        upcoming = length - int(song) - 1

                    if state in ("play", "pause") and upcoming < AUTO_RADIO_THRESHOLD:
                        seed = radio_seed_song(client)
                        if seed:
                            in_queue = queued_files(client)
                            chosen = local_similar_tracks(
                                client, seed, AUTO_RADIO_BATCH, in_queue
                            )
                            for t in chosen:
                                client.add(t["file"])
                finally:
                    try:
                        client.close()
                        client.disconnect()
                    except Exception:
                        pass
        except Exception:
            pass

        time.sleep(5)


def start_background_threads():
    thread = threading.Thread(target=auto_radio_loop, daemon=True)
    thread.start()
    scrobble_thread = threading.Thread(target=scrobble_loop, daemon=True)
    scrobble_thread.start()
    sleep_thread = threading.Thread(target=sleep_timer_loop, daemon=True)
    sleep_thread.start()


def load_recent_plays():
    with _recent_lock:
        if not os.path.exists(RECENT_PATH):
            return []
        try:
            with open(RECENT_PATH, "r", encoding="utf-8") as f:
                data = json.load(f) or []
            return data if isinstance(data, list) else []
        except Exception:
            return []


def save_recent_plays(items):
    with _recent_lock:
        with open(RECENT_PATH, "w", encoding="utf-8") as f:
            json.dump(items[:RECENT_MAX], f, indent=2)


def push_recent_play(song):
    if not song or not song.get("file"):
        return
    entry = {
        "file": song.get("file") or "",
        "title": song.get("title") or "",
        "artist": song.get("artist") or "",
        "album": song.get("album") or "",
        "played_at": int(time.time()),
    }
    items = load_recent_plays()
    # Dedupe consecutive same file
    if items and items[0].get("file") == entry["file"]:
        items[0] = entry
    else:
        items = [entry] + [i for i in items if i.get("file") != entry["file"]]
    save_recent_plays(items)


def listenbrainz_submit(listen_type, payload):
    token = LISTENBRAINZ_CONFIG.get("token") or ""
    if not token or not LISTENBRAINZ_CONFIG.get("enabled"):
        return False, "disabled"
    body = json.dumps({
        "listen_type": listen_type,
        "payload": payload,
    }).encode("utf-8")
    req = urllib.request.Request(
        "https://api.listenbrainz.org/1/submit-listens",
        data=body,
        headers={
            "Authorization": "Token " + token,
            "Content-Type": "application/json",
            "User-Agent": SMART_RADIO_USER_AGENT,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=12) as resp:
            resp.read()
        return True, "ok"
    except Exception as e:
        return False, str(e) or e.__class__.__name__


def scrobble_loop():
    """Track plays locally and optionally scrobble to ListenBrainz."""
    while True:
        try:
            client = get_mpd(timeout=5)
            try:
                status = client.status() or {}
                song = client.currentsong() or {}
            finally:
                try:
                    client.close()
                    client.disconnect()
                except Exception:
                    pass

            state = status.get("state") or "stop"
            songid = str(status.get("songid") or "")
            file_path = song.get("file") or ""
            try:
                elapsed = float(status.get("elapsed") or 0)
            except Exception:
                elapsed = 0.0
            try:
                duration = float(status.get("duration") or song.get("duration") or 0)
            except Exception:
                duration = 0.0

            with _scrobble_lock:
                st = _scrobble_state
                if songid and songid != st["songid"]:
                    # New track started
                    st["songid"] = songid
                    st["file"] = file_path
                    st["title"] = song.get("title") or ""
                    st["artist"] = song.get("artist") or ""
                    st["album"] = song.get("album") or ""
                    st["started"] = time.time()
                    st["duration"] = duration
                    st["scrobbled"] = False
                    st["playing_now_sent"] = False
                    push_recent_play(song)

                if state == "play" and songid and file_path:
                    title = st["title"] or os.path.basename(file_path)
                    artist = st["artist"] or "Unknown Artist"
                    album = st["album"] or ""
                    meta = {
                        "track_metadata": {
                            "track_name": title,
                            "artist_name": artist,
                        }
                    }
                    if album:
                        meta["track_metadata"]["release_name"] = album
                    # additional_info with local file path helps matching
                    meta["track_metadata"]["additional_info"] = {
                        "media_player": "mpd-web",
                        "submission_client": "mpd-web",
                    }

                    if not st["playing_now_sent"]:
                        ok, _ = listenbrainz_submit("playing_now", [meta])
                        if ok:
                            st["playing_now_sent"] = True

                    # Scrobble after half duration or 4 minutes, whichever is lower
                    if duration > 0:
                        threshold = min(max(duration / 2.0, 30.0), 240.0)
                    else:
                        threshold = 240.0
                    if not st["scrobbled"] and elapsed >= threshold:
                        listen = dict(meta)
                        listen["listened_at"] = int(time.time())
                        ok, _ = listenbrainz_submit("single", [listen])
                        if ok:
                            st["scrobbled"] = True

                if state == "stop":
                    st["songid"] = ""
                    st["playing_now_sent"] = False

        except Exception:
            pass

        time.sleep(5)


@app.route("/api/recent")
def recent_api():
    return jsonify({"ok": True, "items": load_recent_plays()})


@app.route("/api/recent/clear", methods=["POST"])
def recent_clear_api():
    save_recent_plays([])
    return jsonify({"ok": True})


@app.route("/api/settings/listenbrainz", methods=["GET", "POST"])
def settings_listenbrainz_api():
    global LISTENBRAINZ_CONFIG
    if request.method == "GET":
        cfg = normalize_listenbrainz_config(LISTENBRAINZ_CONFIG)
        # Never send full token back — mask it
        token = cfg.get("token") or ""
        return jsonify({
            "enabled": cfg.get("enabled"),
            "username": cfg.get("username") or "",
            "has_token": bool(token),
            "token_hint": ("••••" + token[-4:]) if len(token) >= 4 else ("••••" if token else ""),
        })

    data = request.json or {}
    enabled = bool(data.get("enabled"))
    username = str(data.get("username") or "").strip()
    token = data.get("token")
    LISTENBRAINZ_CONFIG["enabled"] = enabled
    LISTENBRAINZ_CONFIG["username"] = username
    if token is not None:
        token = str(token).strip()
        if token:
            LISTENBRAINZ_CONFIG["token"] = token
        elif data.get("clear_token"):
            LISTENBRAINZ_CONFIG["token"] = ""
    save_config()
    return jsonify({"ok": True, "enabled": LISTENBRAINZ_CONFIG["enabled"]})


@app.route("/api/genres")
def genres_api():
    def run(client):
        raw_genres = client.list("genre")
        genres = []

        for g in raw_genres:
            if isinstance(g, dict):
                value = g.get("genre", "")
            else:
                value = str(g)

            value = value.strip()

            if value:
                genres.append(value)

        genres = sorted(list(set(genres)), key=str.lower)

        return jsonify(genres)

    return with_mpd(run)


@app.route("/api/playgenre", methods=["POST"])
def play_genre_api():
    genre = request.json.get("genre", "").strip()

    if not genre:
        return jsonify({"ok": False, "error": "No genre"}), 400

    def run(client):
        results = client.search("genre", genre)

        files = []

        for item in results:
            if isinstance(item, dict) and "file" in item:
                files.append(item["file"])

        if not files:
            return jsonify({
                "ok": False,
                "error": "No tracks found for genre",
                "genre": genre
            }), 404

        client.clear()

        for file_path in files:
            client.add(file_path)

        client.random(1)
        client.play()

        return jsonify({
            "ok": True,
            "genre": genre,
            "tracks": len(files),
            "random": 1
        })

    return with_mpd(run)


@app.route("/api/artists")
def artists_api():
    q = request.args.get("q", "").strip().lower()
    try:
        limit = int(request.args.get("limit", 20))
    except Exception:
        limit = 20
    try:
        offset = int(request.args.get("offset", 0))
    except Exception:
        offset = 0
    limit = max(1, min(limit, 200))
    offset = max(0, offset)

    cache_key = lib_cache_key("artists")
    artists = lib_cache_get(cache_key)

    def build_payload(full):
        filtered = full
        if q:
            filtered = [a for a in full if q in a.lower()]
        total = len(filtered)
        return jsonify({
            "results": filtered[offset:offset + limit],
            "total": total,
            "offset": offset,
            "limit": limit,
            "q": q,
        })

    def run(client):
        nonlocal artists
        if artists is None:
            def collect(tag):
                out = []
                for row in client.list(tag):
                    if isinstance(row, dict):
                        val = row.get(tag, "")
                    else:
                        val = str(row)
                    val = (val or "").strip()
                    if val:
                        out.append(val)
                return out

            artists = collect("albumartist")
            if not artists:
                artists = collect("artist")
            artists = sorted(set(artists), key=str.lower)
            lib_cache_set(cache_key, artists)

        return build_payload(artists)

    if artists is not None:
        return build_payload(artists)

    def fallback():
        nonlocal artists
        lib = get_disk_library()
        artists = list(lib["artists"] or [])
        lib_cache_set(cache_key, artists)
        return build_payload(artists)

    return with_mpd_or(run, fallback, timeout=15)


@app.route("/api/albums")
def albums_api():
    artist = request.args.get("artist", "").strip()
    q = request.args.get("q", "").strip().lower()
    try:
        limit = int(request.args.get("limit", 20))
    except Exception:
        limit = 20
    try:
        offset = int(request.args.get("offset", 0))
    except Exception:
        offset = 0
    limit = max(1, min(limit, 200))
    offset = max(0, offset)

    cache_key = lib_cache_key("albums", artist)
    unique = lib_cache_get(cache_key)

    def build_payload(full):
        filtered = full
        if q:
            filtered = [
                a for a in full
                if q in (a.get("album") or "").lower()
                or q in (a.get("albumartist") or "").lower()
            ]
        total = len(filtered)
        return jsonify({
            "results": filtered[offset:offset + limit],
            "total": total,
            "offset": offset,
            "limit": limit,
            "q": q,
        })

    def run(client):
        nonlocal unique
        if unique is None:
            albums = []
            if artist:
                for row in client.list("album", "albumartist", artist):
                    name = row.get("album", "") if isinstance(row, dict) else str(row)
                    name = (name or "").strip()
                    if name:
                        albums.append({"album": name, "albumartist": artist})
            else:
                try:
                    rows = client.list("album", "group", "albumartist")
                except Exception:
                    rows = client.list("album")

                for row in rows:
                    if isinstance(row, dict):
                        name = (row.get("album", "") or "").strip()
                        aa = (row.get("albumartist", "") or "").strip()
                    else:
                        name = str(row).strip()
                        aa = ""
                    if name:
                        albums.append({"album": name, "albumartist": aa})

            seen = set()
            unique = []
            for a in albums:
                key = (a["album"].lower(), a["albumartist"].lower())
                if key in seen:
                    continue
                seen.add(key)
                unique.append(a)

            unique.sort(key=lambda a: (a["albumartist"].lower(), a["album"].lower()))
            lib_cache_set(cache_key, unique)

        return build_payload(unique)

    if unique is not None:
        return build_payload(unique)

    def fallback():
        nonlocal unique
        lib = get_disk_library()
        albums = list(lib["albums"] or [])
        if artist:
            al = artist.lower()
            exact = [
                a for a in albums
                if (a.get("albumartist") or "").lower() == al
            ]
            albums = exact or [
                a for a in albums
                if al in (a.get("albumartist") or "").lower()
            ]
        unique = albums
        lib_cache_set(cache_key, unique)
        return build_payload(unique)

    return with_mpd_or(run, fallback, timeout=15)


def album_find(client, album, albumartist):
    if albumartist:
        return client.find("album", album, "albumartist", albumartist)
    return client.find("album", album)


def album_track_no(item):
    raw = str(item.get("track", "")).split("/")[0]
    try:
        return int(raw)
    except Exception:
        return 9999


@app.route("/api/albumtracks")
def album_tracks_api():
    album = request.args.get("album", "").strip()
    albumartist = request.args.get("albumartist", "").strip()

    if not album:
        return jsonify([])

    def run(client):
        results = album_find(client, album, albumartist)
        tracks = []

        for item in results:
            if not isinstance(item, dict) or "file" not in item:
                continue
            tracks.append({
                "file": item.get("file", ""),
                "title": item.get("title", ""),
                "artist": item.get("artist", ""),
                "album": item.get("album", ""),
                "track": item.get("track", ""),
                "duration": item.get("duration", "")
            })

        tracks.sort(key=album_track_no)
        return jsonify(tracks)

    def fallback():
        return jsonify(disk_album_tracks(album, albumartist))

    return with_mpd_or(run, fallback, timeout=15)


@app.route("/api/addalbum", methods=["POST"])
def add_album_api():
    data = request.json or {}
    album = str(data.get("album", "")).strip()
    albumartist = str(data.get("albumartist", "")).strip()
    play = bool(data.get("play", False))

    if not album:
        return jsonify({"ok": False, "error": "No album"}), 400

    def run(client):
        results = album_find(client, album, albumartist)

        files = [
            i["file"] for i in sorted(
                [r for r in results if isinstance(r, dict) and "file" in r],
                key=album_track_no
            )
        ]

        if not files:
            return jsonify({"ok": False, "error": "No tracks"}), 404

        if play:
            client.clear()

        for f in files:
            client.add(f)

        if play:
            client.play()

        return jsonify({"ok": True, "tracks": len(files)})

    return with_mpd(run)


@app.route("/api/albumcover")
def album_cover_api():
    album = request.args.get("album", "").strip()
    albumartist = request.args.get("albumartist", "").strip()

    if not album:
        return Response(status=404)

    def run(client):
        results = album_find(client, album, albumartist)

        first_file = ""
        for item in results:
            if isinstance(item, dict) and item.get("file"):
                first_file = item["file"]
                break

        if not first_file:
            return Response(status=404)

        # Prefer folder cover on disk — embedded albumart via MPD is very CPU-heavy.
        return cover_response(client, first_file, allow_mpd=False)

    def fallback():
        tracks = disk_album_tracks(album, albumartist)
        if not tracks:
            return Response(status=404)
        return cover_response(None, tracks[0].get("file", ""), allow_mpd=False)

    return with_mpd_or(run, fallback, timeout=15)


@app.route("/api/update", methods=["POST"])
def update_api():
    def run(client):
        job_id = client.update()
        lib_cache_clear()
        return jsonify({"ok": True, "job": job_id})

    return with_mpd(run)


def detect_image_mime(data):
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"

    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"

    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"

    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"

    return "image/jpeg"


def _extract_binary(data):
    if not isinstance(data, dict):
        return b""

    binary = data.get("binary", b"")

    if isinstance(binary, str):
        binary = binary.encode("latin1")

    return binary or b""


def _read_picture_chunked(command, file_path):
    """Older / raw python-mpd2: fetch the picture chunk-by-chunk with an offset."""
    chunks = []
    offset = 0
    total_size = None

    while True:
        try:
            data = command(file_path, offset)
        except Exception:
            break

        if not data:
            break

        if total_size is None:
            try:
                total_size = int(data.get("size", 0))
            except Exception:
                total_size = 0

        binary = _extract_binary(data)

        if not binary:
            break

        chunks.append(binary)
        offset += len(binary)

        if total_size and offset >= total_size:
            break

    if chunks:
        return b"".join(chunks)

    return None


COVER_FILENAMES = [
    "cover.jpg", "cover.jpeg", "cover.png", "cover.webp",
    "folder.jpg", "folder.jpeg", "folder.png",
    "front.jpg", "front.jpeg", "front.png",
    "album.jpg", "albumart.jpg", "thumb.jpg",
]

IMAGE_EXTENSIONS = ("jpg", "jpeg", "png", "webp", "gif", "bmp")


def _read_file_bytes(path):
    try:
        with open(path, "rb") as f:
            return f.read()
    except Exception:
        return None


def read_cover_from_disk(file_path):
    """Fallback: read folder art directly from the player's music_root on disk."""
    root = active_player().get("music_root")

    if not root or not file_path:
        return None

    folder = os.path.dirname(file_path)
    dir_path = os.path.normpath(os.path.join(root, folder))
    root_abs = os.path.normpath(root)

    # Guard against path traversal (e.g. "../") escaping the music root.
    if dir_path != root_abs and not dir_path.startswith(root_abs + os.sep):
        return None

    if not os.path.isdir(dir_path):
        return None

    try:
        entries = os.listdir(dir_path)
    except Exception:
        return None

    lower_map = {e.lower(): e for e in entries}

    # Prefer well-known cover filenames.
    for name in COVER_FILENAMES:
        if name in lower_map:
            data = _read_file_bytes(os.path.join(dir_path, lower_map[name]))
            if data:
                return data

    # Otherwise fall back to any image file in the folder.
    for entry in entries:
        ext = entry.lower().rsplit(".", 1)[-1] if "." in entry else ""
        if ext in IMAGE_EXTENSIONS:
            data = _read_file_bytes(os.path.join(dir_path, entry))
            if data:
                return data

    return None


def read_mpd_embedded_picture(client, file_path):
    """Read embedded/folder art via MPD only (expensive — prefer disk first)."""
    if not client or not file_path:
        return None
    for command_name in ("readpicture", "albumart"):
        command = getattr(client, command_name, None)

        if command is None:
            continue

        try:
            data = command(file_path)
            binary = _extract_binary(data)
            if binary:
                return binary
        except Exception:
            pass

        chunked = _read_picture_chunked(command, file_path)
        if chunked:
            return chunked

    return None


def read_mpd_picture(client, file_path):
    binary = read_mpd_embedded_picture(client, file_path)
    if binary:
        return binary
    return read_cover_from_disk(file_path)


COVER_CACHE = {}
COVER_CACHE_LIMIT = 300


def ensure_cover_cached(client, file_path, allow_mpd=True):
    if not file_path:
        return False
    cache_key = current_player + "::" + file_path
    if cache_key in COVER_CACHE:
        return True
    # Disk first — avoids hammering MPD with albumart/readpicture.
    image_data = read_cover_from_disk(file_path)
    if not image_data and allow_mpd and client is not None:
        image_data = read_mpd_embedded_picture(client, file_path)
    if not image_data:
        return False
    mime = detect_image_mime(image_data)
    if len(COVER_CACHE) >= COVER_CACHE_LIMIT:
        COVER_CACHE.clear()
    COVER_CACHE[cache_key] = (image_data, mime)
    return True


def cover_response(client, file_path, allow_mpd=True):
    if not ensure_cover_cached(client, file_path, allow_mpd=allow_mpd):
        return Response(status=404)
    image_data, mime = COVER_CACHE[current_player + "::" + file_path]
    return Response(
        image_data,
        mimetype=mime,
        headers={
            "Cache-Control": "public, max-age=86400"
        }
    )


@app.route("/api/cover/warm", methods=["POST"])
def cover_warm_api():
    """Warm cover cache from disk only — never call MPD albumart."""
    data = request.json or {}
    files = data.get("files") or []
    warmed = 0
    seen = set()

    for fp in files[:40]:
        if not isinstance(fp, str) or not fp or fp in seen:
            continue
        seen.add(fp)
        if ensure_cover_cached(None, fp, allow_mpd=False):
            warmed += 1

    return jsonify({"ok": True, "warmed": warmed})


@app.route("/api/cover")
def cover_api():
    file_path = request.args.get("file", "").strip()
    disk_only = request.args.get("disk", "").strip().lower() in ("1", "true", "yes")

    if not file_path:
        return Response(status=404)

    # Disk first — works when MPD (e.g. iFi) is powered off.
    if ensure_cover_cached(None, file_path, allow_mpd=False):
        image_data, mime = COVER_CACHE[current_player + "::" + file_path]
        return Response(
            image_data,
            mimetype=mime,
            headers={"Cache-Control": "public, max-age=86400"}
        )

    if disk_only:
        return Response(status=404)

    def run(client):
        return cover_response(client, file_path, allow_mpd=True)

    return with_mpd(run)


AUDIO_MIME = {
    ".flac": "audio/flac",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".wave": "audio/wav",
    ".aiff": "audio/aiff",
    ".aif": "audio/aiff",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".ogg": "audio/ogg",
    ".opus": "audio/ogg",
    ".dsf": "audio/x-dsf",
    ".dff": "audio/x-dff",
    ".wv": "audio/x-wavpack",
    ".ape": "audio/x-ape",
}


def guess_audio_mime(path):
    ext = os.path.splitext(path or "")[1].lower()
    if ext in AUDIO_MIME:
        return AUDIO_MIME[ext]
    guessed, _ = mimetypes.guess_type(path or "")
    return guessed or "application/octet-stream"


def resolve_music_file(rel_path):
    """Resolve an MPD-relative path under the active player's music_root."""
    root = active_player().get("music_root")
    if not root or not rel_path:
        return None, "music_root not configured for this player"
    rel = rel_path.lstrip("/")
    root_abs = os.path.realpath(root)
    full = os.path.realpath(os.path.join(root_abs, rel))
    if full != root_abs and not full.startswith(root_abs + os.sep):
        return None, "invalid path"
    if not os.path.isfile(full):
        return None, "file not found on disk"
    return full, None


def dlna_public_base(fallback_host_url=""):
    base = (DLNA_CONFIG.get("public_base") or "").strip().rstrip("/")
    if base:
        return base
    host = (fallback_host_url or request.host_url or "").strip().rstrip("/")
    return host


def build_dlna_stream_url(rel_path, base=""):
    base = (base or dlna_public_base()).rstrip("/")
    return base + "/api/dlna/stream?file=" + urllib.parse.quote(rel_path, safe="")


@app.route("/api/dlna/devices")
def dlna_devices_api():
    devices = dlna_cast.cached_renderers()
    return jsonify({
        "ok": True,
        "devices": devices,
        "selected": {
            "udn": DLNA_CONFIG.get("selected_udn") or "",
            "location": DLNA_CONFIG.get("selected_location") or "",
            "name": DLNA_CONFIG.get("selected_name") or "",
        },
        "public_base": DLNA_CONFIG.get("public_base") or "",
    })


@app.route("/api/dlna/scan", methods=["POST"])
def dlna_scan_api():
    try:
        timeout = int((request.json or {}).get("timeout", 5))
    except Exception:
        timeout = 5
    timeout = max(2, min(timeout, 12))
    try:
        devices = dlna_cast.discover_renderers(timeout=timeout)
        return jsonify({"ok": True, "devices": devices})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e) or e.__class__.__name__}), 500


@app.route("/api/dlna/select", methods=["POST"])
def dlna_select_api():
    global DLNA_CONFIG
    data = request.json or {}
    udn = str(data.get("udn") or "").strip()
    location = str(data.get("location") or "").strip()
    name = str(data.get("name") or "").strip()
    public_base = data.get("public_base")
    if public_base is not None:
        DLNA_CONFIG["public_base"] = str(public_base).strip().rstrip("/")
    if not location and not udn:
        DLNA_CONFIG["selected_udn"] = ""
        DLNA_CONFIG["selected_location"] = ""
        DLNA_CONFIG["selected_name"] = ""
        save_config()
        return jsonify({"ok": True, "selected": DLNA_CONFIG})

    cached = dlna_cast.find_cached(udn=udn, location=location) or {}
    DLNA_CONFIG["selected_udn"] = udn or cached.get("udn") or ""
    DLNA_CONFIG["selected_location"] = location or cached.get("location") or ""
    DLNA_CONFIG["selected_name"] = name or cached.get("name") or ""
    if DLNA_CONFIG["selected_location"]:
        dlna_cast.remember_device({
            "udn": DLNA_CONFIG["selected_udn"],
            "location": DLNA_CONFIG["selected_location"],
            "name": DLNA_CONFIG["selected_name"],
            "model": cached.get("model") or "",
        })
    save_config()
    return jsonify({"ok": True, "selected": {
        "udn": DLNA_CONFIG["selected_udn"],
        "location": DLNA_CONFIG["selected_location"],
        "name": DLNA_CONFIG["selected_name"],
    }, "public_base": DLNA_CONFIG.get("public_base") or ""})


@app.route("/api/dlna/play", methods=["POST"])
def dlna_play_api():
    data = request.json or {}
    rel = str(data.get("file") or "").strip()
    if not rel:
        return jsonify({"ok": False, "error": "No file"}), 400

    location = DLNA_CONFIG.get("selected_location") or ""
    if not location:
        return jsonify({"ok": False, "error": "No DLNA device selected — scan and pick one in Settings"}), 400

    full, err = resolve_music_file(rel)
    if err:
        return jsonify({"ok": False, "error": err}), 400

    title = str(data.get("title") or os.path.basename(rel))
    artist = str(data.get("artist") or "")
    album = str(data.get("album") or "")

    try:
        def meta(client):
            rows = client.find("file", rel)
            return rows[0] if rows else {}

        tags = with_mpd(meta)
        if isinstance(tags, tuple) or not isinstance(tags, dict):
            tags = {}
        if tags.get("file"):
            title = tags.get("title") or title
            artist = tags.get("artist") or artist
            album = tags.get("album") or album
    except Exception:
        pass

    mime = guess_audio_mime(full)
    base = dlna_public_base()
    if not base:
        return jsonify({
            "ok": False,
            "error": "Set DLNA public base URL in Settings (e.g. http://192.168.9.232:5000)"
        }), 400

    # Persist discovered base if empty so stream URLs stay stable.
    if not DLNA_CONFIG.get("public_base"):
        DLNA_CONFIG["public_base"] = base
        save_config()

    media_url = build_dlna_stream_url(rel, base)
    try:
        dlna_cast.play_uri(location, media_url, title, artist, album, mime)
        return jsonify({
            "ok": True,
            "device": DLNA_CONFIG.get("selected_name") or location,
            "url": media_url,
            "title": title,
        })
    except Exception as e:
        return jsonify({"ok": False, "error": str(e) or e.__class__.__name__}), 500


@app.route("/api/dlna/cmd", methods=["POST"])
def dlna_cmd_api():
    data = request.json or {}
    action = str(data.get("action") or "").strip().lower()
    location = DLNA_CONFIG.get("selected_location") or ""
    if not location:
        return jsonify({"ok": False, "error": "No DLNA device selected"}), 400
    if action in ("play", "pause", "stop"):
        try:
            dlna_cast.transport(location, action)
            return jsonify({"ok": True, "action": action})
        except Exception as e:
            return jsonify({"ok": False, "error": str(e) or e.__class__.__name__}), 500
    if action == "volume":
        try:
            percent = float(data.get("percent", 50))
        except Exception:
            percent = 50
        try:
            dlna_cast.set_volume(location, percent)
            return jsonify({"ok": True, "action": "volume", "percent": percent})
        except Exception as e:
            return jsonify({"ok": False, "error": str(e) or e.__class__.__name__}), 500
    return jsonify({"ok": False, "error": "Unknown action"}), 400


@app.route("/api/dlna/stream", methods=["GET", "HEAD"])
def dlna_stream_api():
    rel = request.args.get("file", "").strip()
    full, err = resolve_music_file(rel)
    if err:
        return Response(err, status=404)

    mime = guess_audio_mime(full)
    size = os.path.getsize(full)
    headers = {
        "Content-Type": mime,
        "Accept-Ranges": "bytes",
        "Content-Length": str(size),
        "contentFeatures.dlna.org": "DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000",
        "transferMode.dlna.org": "Streaming",
        "Cache-Control": "no-cache",
    }

    range_header = request.headers.get("Range")
    if not range_header:
        if request.method == "HEAD":
            return Response(status=200, headers=headers)

        def generate_full():
            with open(full, "rb") as f:
                while True:
                    chunk = f.read(64 * 1024)
                    if not chunk:
                        break
                    yield chunk

        return Response(generate_full(), status=200, headers=headers, direct_passthrough=True)

    # bytes=start-end
    try:
        units, rng = range_header.split("=", 1)
        if units.strip() != "bytes":
            return Response(status=416)
        start_s, end_s = (rng.split("-", 1) + [""])[:2]
        start = int(start_s) if start_s else 0
        end = int(end_s) if end_s else size - 1
    except Exception:
        return Response(status=416)

    if start < 0 or start >= size:
        return Response(status=416, headers={"Content-Range": f"bytes */{size}"})
    end = min(end, size - 1)
    length = end - start + 1
    headers["Content-Length"] = str(length)
    headers["Content-Range"] = f"bytes {start}-{end}/{size}"

    if request.method == "HEAD":
        return Response(status=206, headers=headers)

    def generate_range():
        with open(full, "rb") as f:
            f.seek(start)
            remaining = length
            while remaining > 0:
                chunk = f.read(min(64 * 1024, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                yield chunk

    return Response(generate_range(), status=206, headers=headers, direct_passthrough=True)


if __name__ == "__main__":
    # Start the auto-radio worker once. Under the debug reloader, only the
    # reloaded child process (WERKZEUG_RUN_MAIN) should start it.
    if not DEBUG or os.environ.get("WERKZEUG_RUN_MAIN") == "true":
        start_background_threads()

    # threaded=True so one slow/unreachable MPD request can't freeze the whole
    # UI (the page fires several API calls at once on load).
    app.run(host="192.168.9.232", port=5000, debug=DEBUG, threaded=True)
