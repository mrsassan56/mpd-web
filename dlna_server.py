"""DLNA MediaServer (ContentDirectory) discovery and browse helpers."""

from __future__ import annotations

import logging
import threading
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

_DMS_CACHE: Dict[str, Dict[str, Any]] = {}
_CACHE_LOCK = threading.Lock()


def _run(coro):
    import asyncio

    result: Dict[str, Any] = {}
    error: List[BaseException] = []

    def worker():
        try:
            result["value"] = asyncio.run(coro)
        except BaseException as e:  # noqa: BLE001
            error.append(e)

    t = threading.Thread(target=worker, daemon=True)
    t.start()
    t.join(timeout=90)
    if t.is_alive():
        raise TimeoutError("DLNA server operation timed out")
    if error:
        raise error[0]
    return result.get("value")


def _header(data: Any, *keys: str, default: str = "") -> str:
    for key in keys:
        try:
            val = data.get(key)
        except Exception:
            val = None
        if val:
            return str(val)
    return default


def _upnp_class(obj) -> str:
    return str(getattr(obj, "upnp_class", None) or getattr(obj, "class", None) or "")


def _is_audio_item(obj) -> bool:
    cls = _upnp_class(obj).lower()
    return "audioitem" in cls or "musictrack" in cls


def _is_container(obj) -> bool:
    if _is_audio_item(obj):
        return False
    cls = _upnp_class(obj).lower()
    if "container" in cls:
        return True
    return type(obj).__name__ in ("Container", "Genre", "Album", "Person")


def _pick_resource(resources) -> Dict[str, str]:
    """Pick the best playable HTTP URL from DIDL resources."""
    best = None
    best_score = -1
    for res in resources or []:
        uri = getattr(res, "uri", None) or (res if isinstance(res, str) else "")
        if not uri or not str(uri).startswith("http"):
            continue
        proto = str(getattr(res, "protocol_info", "") or "").lower()
        score = 0
        if "audio/x-flac" in proto or ".flac" in uri.lower():
            score = 100
        elif "audio/mpeg" in proto or ".mp3" in uri.lower():
            score = 90
        elif "audio/mp4" in proto or "audio/aac" in proto or ".m4a" in uri.lower():
            score = 85
        elif "audio/ogg" in proto:
            score = 80
        elif "audio/wav" in proto:
            score = 40
        elif "audio/l16" in proto or "lpcm" in proto:
            score = 20
        else:
            score = 50
        if score > best_score:
            best_score = score
            mime = "audio/mpeg"
            if "flac" in proto or uri.lower().endswith(".flac"):
                mime = "audio/x-flac"
            elif "wav" in proto:
                mime = "audio/wav"
            elif "mp4" in proto or "aac" in proto:
                mime = "audio/mp4"
            elif "ogg" in proto:
                mime = "audio/ogg"
            best = {"url": str(uri), "mime": mime, "protocol_info": proto}
    return best or {}


def _serialize_item(obj) -> Dict[str, Any]:
    title = str(getattr(obj, "title", None) or getattr(obj, "name", None) or "Untitled")
    oid = str(getattr(obj, "id", None) or "")
    parent_id = str(getattr(obj, "parent_id", None) or "")
    artist = str(getattr(obj, "artist", None) or getattr(obj, "creator", None) or "")
    album = str(getattr(obj, "album", None) or "")
    genre = str(getattr(obj, "genre", None) or "")
    art = str(getattr(obj, "album_art_uri", None) or "")

    if _is_container(obj):
        return {
            "type": "directory",
            "id": oid,
            "parent_id": parent_id,
            "title": title,
            "artist": artist,
            "album": album,
            "genre": genre,
            "art": art,
            "upnp_class": _upnp_class(obj),
        }

    res = _pick_resource(getattr(obj, "res", None) or [])
    return {
        "type": "file",
        "id": oid,
        "parent_id": parent_id,
        "title": title,
        "artist": artist,
        "album": album,
        "genre": genre,
        "art": art,
        "url": res.get("url", ""),
        "mime": res.get("mime", "audio/mpeg"),
        "upnp_class": _upnp_class(obj),
    }


async def _async_discover(timeout: int = 5) -> List[Dict[str, Any]]:
    from async_upnp_client.aiohttp import AiohttpRequester
    from async_upnp_client.client_factory import UpnpFactory
    from async_upnp_client.profiles.dlna import DmsDevice

    responses = await DmsDevice.async_search(timeout=timeout)
    factory = UpnpFactory(AiohttpRequester(), non_strict=True)
    devices: List[Dict[str, Any]] = []
    seen = set()

    for resp in responses:
        location = _header(resp, "location", "LOCATION")
        udn = _header(resp, "_udn", "usn", "USN")
        if not location:
            continue
        key = location
        if key in seen:
            continue
        seen.add(key)

        name = ""
        model = ""
        try:
            device = await factory.async_create_device(location)
            dms = DmsDevice(device, None)
            name = dms.name or dms.friendly_name or ""
            model = getattr(dms, "model_name", None) or ""
            if not udn:
                udn = dms.udn or ""
        except Exception as e:
            logger.debug("DMS describe failed for %s: %s", location, e)
            name = _header(resp, "server", "SERVER") or location

        entry = {
            "udn": udn,
            "name": name or "DLNA server",
            "location": location,
            "model": model or "",
        }
        devices.append(entry)

    devices.sort(key=lambda d: d["name"].lower())
    return devices


def discover_servers(timeout: int = 5) -> List[Dict[str, Any]]:
    devices = _run(_async_discover(timeout=timeout)) or []
    with _CACHE_LOCK:
        _DMS_CACHE.clear()
        for d in devices:
            key = d.get("location") or d.get("udn")
            if key:
                _DMS_CACHE[key] = d
    return devices


def cached_servers() -> List[Dict[str, Any]]:
    with _CACHE_LOCK:
        return list(_DMS_CACHE.values())


def find_cached_server(location: str = "", udn: str = "") -> Optional[Dict[str, Any]]:
    with _CACHE_LOCK:
        if location and location in _DMS_CACHE:
            return dict(_DMS_CACHE[location])
        for d in _DMS_CACHE.values():
            if location and d.get("location") == location:
                return dict(d)
            if udn and d.get("udn") == udn:
                return dict(d)
    return None


async def _async_get_dms(location: str):
    from async_upnp_client.aiohttp import AiohttpRequester
    from async_upnp_client.client_factory import UpnpFactory
    from async_upnp_client.profiles.dlna import DmsDevice

    factory = UpnpFactory(AiohttpRequester(), non_strict=True)
    device = await factory.async_create_device(location)
    return DmsDevice(device, None)


async def _async_browse(
    location: str,
    object_id: str = "0",
    start: int = 0,
    count: int = 200,
) -> Dict[str, Any]:
    dms = await _async_get_dms(location)
    result = await dms.async_browse(
        object_id or "0",
        "BrowseDirectChildren",
        starting_index=max(0, int(start)),
        requested_count=max(1, min(int(count), 500)),
    )
    items = [_serialize_item(obj) for obj in (result.result or [])]
    return {
        "items": items,
        "object_id": object_id or "0",
        "total": int(result.total_matches or 0),
        "returned": int(result.number_returned or len(items)),
        "update_id": int(result.update_id or 0),
        "server_name": dms.name or dms.friendly_name or "",
    }


def browse(
    location: str,
    object_id: str = "0",
    start: int = 0,
    count: int = 200,
) -> Dict[str, Any]:
    return _run(_async_browse(location, object_id, start, count))


async def _async_search(location: str, query: str, container_id: str = "0") -> Dict[str, Any]:
    dms = await _async_get_dms(location)
    result = await dms.async_search_directory(container_id or "0", query or "*")
    items = [_serialize_item(obj) for obj in (result.result or [])]
    return {
        "items": items,
        "query": query,
        "total": int(result.total_matches or len(items)),
        "returned": int(result.number_returned or len(items)),
        "server_name": dms.name or dms.friendly_name or "",
    }


def search(location: str, query: str, container_id: str = "0") -> Dict[str, Any]:
    return _run(_async_search(location, query, container_id))
