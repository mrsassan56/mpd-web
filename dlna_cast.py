"""DLNA/UPnP MediaRenderer discovery and cast helpers."""

from __future__ import annotations

import asyncio
import html
import logging
import threading
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

_DMR_CACHE: Dict[str, Dict[str, Any]] = {}
_CACHE_LOCK = threading.Lock()


def _run(coro):
    """Run an async coroutine from sync Flask handlers."""
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
        raise TimeoutError("DLNA operation timed out")
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


async def _async_discover(timeout: int = 5) -> List[Dict[str, Any]]:
    from async_upnp_client.aiohttp import AiohttpRequester
    from async_upnp_client.client_factory import UpnpFactory
    from async_upnp_client.profiles.dlna import DmrDevice

    responses = await DmrDevice.async_search(timeout=timeout)
    factory = UpnpFactory(AiohttpRequester(), non_strict=True)
    devices: List[Dict[str, Any]] = []
    seen = set()

    for resp in responses:
        location = _header(resp, "location", "LOCATION")
        udn = _header(resp, "_udn", "usn", "USN")
        if not location:
            continue
        key = udn or location
        if key in seen:
            continue
        seen.add(key)

        name = ""
        model = ""
        try:
            device = await factory.async_create_device(location)
            if not DmrDevice.is_profile_device(device):
                # Still list it if SSDP ST matched MediaRenderer.
                pass
            name = device.name or device.friendly_name or ""
            model = getattr(device, "model_name", None) or ""
            if not udn:
                udn = device.udn or ""
        except Exception as e:
            logger.debug("DLNA describe failed for %s: %s", location, e)
            name = _header(resp, "server", "SERVER") or location

        entry = {
            "udn": udn,
            "name": name or "DLNA device",
            "location": location,
            "model": model or "",
        }
        devices.append(entry)

    devices.sort(key=lambda d: d["name"].lower())
    return devices


def discover_renderers(timeout: int = 5) -> List[Dict[str, Any]]:
    devices = _run(_async_discover(timeout=timeout)) or []
    with _CACHE_LOCK:
        _DMR_CACHE.clear()
        for d in devices:
            key = d.get("udn") or d.get("location")
            if key:
                _DMR_CACHE[key] = d
    return devices


def cached_renderers() -> List[Dict[str, Any]]:
    with _CACHE_LOCK:
        return list(_DMR_CACHE.values())


def find_cached(udn: str = "", location: str = "") -> Optional[Dict[str, Any]]:
    with _CACHE_LOCK:
        if udn and udn in _DMR_CACHE:
            return dict(_DMR_CACHE[udn])
        for d in _DMR_CACHE.values():
            if location and d.get("location") == location:
                return dict(d)
            if udn and d.get("udn") == udn:
                return dict(d)
    return None


def remember_device(device: Dict[str, Any]) -> None:
    key = device.get("udn") or device.get("location")
    if not key:
        return
    with _CACHE_LOCK:
        _DMR_CACHE[key] = dict(device)


def build_didl_lite(
    media_url: str,
    title: str,
    artist: str = "",
    album: str = "",
    mime: str = "audio/mpeg",
) -> str:
    title_x = html.escape(title or "Track", quote=True)
    artist_x = html.escape(artist or "", quote=True)
    album_x = html.escape(album or "", quote=True)
    url_x = html.escape(media_url, quote=True)
    mime_x = html.escape(mime or "audio/mpeg", quote=True)
    protocol = f"http-get:*:{mime_x}:DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000"
    parts = [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"',
        ' xmlns:dc="http://purl.org/dc/elements/1.1/"',
        ' xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">',
        '<item id="0" parentID="-1" restricted="1">',
        f"<dc:title>{title_x}</dc:title>",
        "<upnp:class>object.item.audioItem.musicTrack</upnp:class>",
    ]
    if artist_x:
        parts.append(f"<upnp:artist>{artist_x}</upnp:artist>")
        parts.append(f"<dc:creator>{artist_x}</dc:creator>")
    if album_x:
        parts.append(f"<upnp:album>{album_x}</upnp:album>")
    parts.append(f'<res protocolInfo="{protocol}">{url_x}</res>')
    parts.append("</item></DIDL-Lite>")
    return "".join(parts)


async def _async_get_dmr(location: str):
    from async_upnp_client.aiohttp import AiohttpRequester
    from async_upnp_client.client_factory import UpnpFactory
    from async_upnp_client.profiles.dlna import DmrDevice

    factory = UpnpFactory(AiohttpRequester(), non_strict=True)
    device = await factory.async_create_device(location)
    return DmrDevice(device, None)


async def _async_play_uri(
    location: str,
    media_url: str,
    title: str,
    artist: str = "",
    album: str = "",
    mime: str = "audio/mpeg",
) -> None:
    dmr = await _async_get_dmr(location)
    meta = build_didl_lite(media_url, title, artist, album, mime)
    try:
        await dmr.async_stop()
    except Exception:
        pass
    await dmr.async_set_transport_uri(media_url, title or "Track", meta)
    try:
        await dmr.async_wait_for_can_play(max_wait_time=3)
    except Exception:
        pass
    await dmr.async_play()


def play_uri(
    location: str,
    media_url: str,
    title: str,
    artist: str = "",
    album: str = "",
    mime: str = "audio/mpeg",
) -> None:
    _run(_async_play_uri(location, media_url, title, artist, album, mime))


async def _async_transport(location: str, action: str) -> None:
    dmr = await _async_get_dmr(location)
    action = (action or "").lower()
    if action == "play":
        await dmr.async_play()
    elif action == "pause":
        await dmr.async_pause()
    elif action == "stop":
        await dmr.async_stop()
    else:
        raise ValueError("Unknown action: " + action)


def transport(location: str, action: str) -> None:
    _run(_async_transport(location, action))


async def _async_set_volume(location: str, percent: float) -> None:
    dmr = await _async_get_dmr(location)
    level = max(0.0, min(1.0, float(percent) / 100.0))
    await dmr.async_set_volume_level(level)


def set_volume(location: str, percent: float) -> None:
    _run(_async_set_volume(location, percent))
