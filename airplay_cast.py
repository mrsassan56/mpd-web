"""AirPlay / RAOP discovery and casting via pyatv."""

from __future__ import annotations

import asyncio
import logging
import threading
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

_DEVICE_CACHE: Dict[str, Dict[str, Any]] = {}
_CACHE_LOCK = threading.Lock()
_PLAY_LOCK = threading.Lock()
_ACTIVE: Dict[str, Any] = {
    "thread": None,
    "stop": False,
    "identifier": "",
    "file": "",
}
_PAIRING: Dict[str, Any] = {
    "handler": None,
    "loop": None,
    "thread": None,
    "identifier": "",
    "awaiting_pin": False,
}


def _run(coro, timeout: float = 90):
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
    t.join(timeout=timeout)
    if t.is_alive():
        raise TimeoutError("AirPlay operation timed out")
    if error:
        raise error[0]
    return result.get("value")


def _conf_to_dict(conf) -> Dict[str, Any]:
    """Serialize a pyatv device config to a JSON-friendly dict."""
    services = []
    try:
        for svc in conf.services:
            services.append(str(getattr(svc, "protocol", svc)))
    except Exception:
        pass
    address = ""
    try:
        address = str(conf.address) if conf.address is not None else ""
    except Exception:
        address = ""
    return {
        "identifier": str(conf.identifier or ""),
        "name": str(conf.name or "AirPlay device"),
        "address": address,
        "model": str(getattr(conf.device_info, "model_str", "") or
                     getattr(getattr(conf, "device_info", None), "model", "") or ""),
        "services": services,
    }


async def _async_discover(timeout: float = 5) -> List[Dict[str, Any]]:
    from pyatv import scan

    loop = asyncio.get_running_loop()
    try:
        devices_found = await scan(loop, timeout=timeout)
    except TypeError:
        # Newer pyatv: loop is optional / keyword-only
        devices_found = await scan(timeout=timeout)
    devices: List[Dict[str, Any]] = []
    seen = set()
    for conf in devices_found or []:
        entry = _conf_to_dict(conf)
        key = entry.get("identifier") or entry.get("address")
        if not key or key in seen:
            continue
        seen.add(key)
        devices.append(entry)

    devices.sort(key=lambda d: (d.get("name") or "").lower())
    return devices


def discover_devices(timeout: float = 5) -> List[Dict[str, Any]]:
    devices = _run(_async_discover(timeout=timeout), timeout=max(15, timeout + 10)) or []
    with _CACHE_LOCK:
        _DEVICE_CACHE.clear()
        for d in devices:
            key = d.get("identifier") or d.get("address")
            if key:
                _DEVICE_CACHE[key] = d
    return devices


def cached_devices() -> List[Dict[str, Any]]:
    with _CACHE_LOCK:
        return list(_DEVICE_CACHE.values())


def find_cached(identifier: str = "", address: str = "") -> Optional[Dict[str, Any]]:
    with _CACHE_LOCK:
        if identifier and identifier in _DEVICE_CACHE:
            return dict(_DEVICE_CACHE[identifier])
        for d in _DEVICE_CACHE.values():
            if identifier and d.get("identifier") == identifier:
                return dict(d)
            if address and d.get("address") == address:
                return dict(d)
    return None


def remember_device(device: Dict[str, Any]) -> None:
    if not isinstance(device, dict):
        return
    key = device.get("identifier") or device.get("address")
    if not key:
        return
    with _CACHE_LOCK:
        _DEVICE_CACHE[key] = {
            "identifier": device.get("identifier") or "",
            "name": device.get("name") or "AirPlay device",
            "address": device.get("address") or "",
            "model": device.get("model") or "",
            "services": device.get("services") or [],
        }


async def _find_conf(identifier: str, address: str = "", timeout: float = 5):
    from pyatv import scan

    loop = asyncio.get_running_loop()
    hosts = [address] if address else None
    try:
        found = await scan(loop, timeout=timeout, hosts=hosts)
    except TypeError:
        found = await scan(timeout=timeout, hosts=hosts)
    for conf in found or []:
        if identifier and str(conf.identifier) == str(identifier):
            return conf
        if address and str(conf.address) == str(address):
            return conf
    if found:
        # Fallback: first device if only one host scanned
        if hosts and len(found) == 1:
            return found[0]
    return None


async def _async_play_media(
    identifier: str,
    address: str,
    file_path: str = "",
    media_url: str = "",
    credentials: str = "",
    title: str = "",
    artist: str = "",
    album: str = "",
):
    from pyatv import connect
    from pyatv.const import Protocol
    from pyatv.interface import MediaMetadata
    from pyatv.exceptions import NotSupportedError

    loop = asyncio.get_running_loop()
    conf = await _find_conf(identifier, address=address, timeout=6)
    if conf is None:
        raise RuntimeError("AirPlay device not found on network — scan again")

    if credentials:
        for protocol in (Protocol.AirPlay, Protocol.RAOP):
            try:
                svc = conf.get_service(protocol)
                if svc is not None:
                    svc.credentials = credentials
            except Exception:
                pass

    try:
        atv = await connect(conf, loop=loop)
    except TypeError:
        atv = await connect(conf, loop)

    metadata = None
    if title or artist or album:
        try:
            metadata = MediaMetadata(
                title=title or None,
                artist=artist or None,
                album=album or None,
            )
        except Exception:
            metadata = None

    try:
        url = (media_url or "").strip()
        path = (file_path or "").strip()
        last_err = None

        if url.startswith(("http://", "https://")):
            try:
                if metadata is not None:
                    await atv.stream.play_url(url, metadata=metadata)
                else:
                    await atv.stream.play_url(url)
                return
            except NotSupportedError as e:
                last_err = e
                logger.info("AirPlay play_url not supported, falling back to stream_file")
            except Exception as e:
                last_err = e
                logger.info("AirPlay play_url failed (%s), trying stream_file", e)

        if path:
            if metadata is not None:
                await atv.stream.stream_file(path, metadata=metadata)
            else:
                await atv.stream.stream_file(path)
            return

        if last_err:
            raise RuntimeError("AirPlay could not play URL: " + str(last_err))
        raise ValueError("No file path or media URL to play")
    finally:
        try:
            await atv.close()
        except Exception:
            pass


async def _async_play_file(
    identifier: str,
    address: str,
    file_path: str,
    credentials: str = "",
    title: str = "",
    artist: str = "",
    album: str = "",
    stop_flag: Optional[threading.Event] = None,
):
    if stop_flag and stop_flag.is_set():
        return
    await _async_play_media(
        identifier=identifier,
        address=address,
        file_path=file_path,
        credentials=credentials,
        title=title,
        artist=artist,
        album=album,
    )


def play_media(
    identifier: str,
    file_path: str = "",
    media_url: str = "",
    address: str = "",
    credentials: str = "",
    title: str = "",
    artist: str = "",
    album: str = "",
) -> Dict[str, Any]:
    """Play via HTTP URL (preferred for Apple TV) or local file (RAOP speakers)."""
    if not identifier and not address:
        raise ValueError("No AirPlay device identifier")
    if not (media_url or file_path):
        raise ValueError("No media URL or file path")

    with _PLAY_LOCK:
        prev = _ACTIVE.get("stop")
        if isinstance(prev, threading.Event):
            prev.set()

    _run(_async_play_media(
        identifier=identifier,
        address=address,
        file_path=file_path,
        media_url=media_url,
        credentials=credentials,
        title=title,
        artist=artist,
        album=album,
    ), timeout=75)

    with _PLAY_LOCK:
        _ACTIVE["identifier"] = identifier
        _ACTIVE["file"] = file_path or media_url

    return {
        "ok": True,
        "identifier": identifier,
        "file": file_path,
        "url": media_url,
    }


def play_file(
    identifier: str,
    file_path: str,
    address: str = "",
    credentials: str = "",
    title: str = "",
    artist: str = "",
    album: str = "",
    media_url: str = "",
) -> Dict[str, Any]:
    """Play on AirPlay — prefers LAN HTTP URL when provided."""
    if media_url:
        return play_media(
            identifier=identifier,
            address=address,
            file_path=file_path,
            media_url=media_url,
            credentials=credentials,
            title=title,
            artist=artist,
            album=album,
        )

    stop_flag = threading.Event()

    def worker():
        try:
            asyncio.run(_async_play_file(
                identifier=identifier,
                address=address,
                file_path=file_path,
                credentials=credentials,
                title=title,
                artist=artist,
                album=album,
                stop_flag=stop_flag,
            ))
        except Exception as e:
            logger.warning("AirPlay play failed: %s", e)
        finally:
            with _PLAY_LOCK:
                if _ACTIVE.get("stop") is stop_flag:
                    _ACTIVE["thread"] = None
                    _ACTIVE["identifier"] = ""
                    _ACTIVE["file"] = ""

    with _PLAY_LOCK:
        prev = _ACTIVE.get("stop")
        if isinstance(prev, threading.Event):
            prev.set()
        _ACTIVE["stop"] = stop_flag
        _ACTIVE["identifier"] = identifier
        _ACTIVE["file"] = file_path
        t = threading.Thread(target=worker, daemon=True)
        _ACTIVE["thread"] = t
        t.start()

    return {"ok": True, "identifier": identifier, "file": file_path}


def stop_playback() -> Dict[str, Any]:
    with _PLAY_LOCK:
        stop_flag = _ACTIVE.get("stop")
        if isinstance(stop_flag, threading.Event):
            stop_flag.set()
        _ACTIVE["identifier"] = ""
        _ACTIVE["file"] = ""
    # Best-effort: reconnect and ask device to stop (stream_file may already be ending).
    return {"ok": True}


def playback_status() -> Dict[str, Any]:
    with _PLAY_LOCK:
        t = _ACTIVE.get("thread")
        alive = bool(t and t.is_alive())
        return {
            "playing": alive,
            "identifier": _ACTIVE.get("identifier") or "",
            "file": _ACTIVE.get("file") or "",
        }


# --- Pairing (PIN) -----------------------------------------------------------

async def _async_pair_start(identifier: str, address: str = ""):
    from pyatv import pair
    from pyatv.const import Protocol

    loop = asyncio.get_running_loop()
    conf = await _find_conf(identifier, address=address, timeout=6)
    if conf is None:
        raise RuntimeError("AirPlay device not found — scan again")

    # Prefer AirPlay pairing; fall back to RAOP.
    protocol = Protocol.AirPlay
    try:
        if conf.get_service(Protocol.AirPlay) is None:
            protocol = Protocol.RAOP
    except Exception:
        protocol = Protocol.RAOP

    try:
        pairing = await pair(conf, protocol, loop)
    except TypeError:
        pairing = await pair(conf, protocol, loop=loop)
    await pairing.begin()
    return pairing, conf, protocol


def pair_start(identifier: str, address: str = "") -> Dict[str, Any]:
    """Begin pairing; device should show a PIN. Call pair_finish next."""
    # Run pairing session on a dedicated long-lived loop/thread.
    ready = threading.Event()
    state: Dict[str, Any] = {"error": None, "needs_pin": True}

    def worker():
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            pairing, conf, protocol = loop.run_until_complete(
                _async_pair_start(identifier, address=address)
            )
            _PAIRING["handler"] = pairing
            _PAIRING["loop"] = loop
            _PAIRING["identifier"] = identifier
            _PAIRING["awaiting_pin"] = True
            _PAIRING["conf"] = conf
            _PAIRING["protocol"] = protocol
            state["name"] = getattr(conf, "name", "") or identifier
            ready.set()
            # Keep loop alive until pair_finish / pair_cancel
            while _PAIRING.get("awaiting_pin"):
                loop.run_until_complete(asyncio.sleep(0.25))
        except Exception as e:
            state["error"] = e
            ready.set()
        finally:
            try:
                loop.close()
            except Exception:
                pass

    # Cancel any previous pairing
    pair_cancel()

    t = threading.Thread(target=worker, daemon=True)
    _PAIRING["thread"] = t
    t.start()
    if not ready.wait(timeout=30):
        pair_cancel()
        raise TimeoutError("AirPlay pairing start timed out")
    if state.get("error"):
        raise state["error"]
    return {
        "ok": True,
        "needs_pin": True,
        "identifier": identifier,
        "name": state.get("name") or identifier,
    }


def pair_finish(pin: str) -> Dict[str, Any]:
    pin = str(pin or "").strip()
    if not pin:
        raise ValueError("PIN required")
    pairing = _PAIRING.get("handler")
    loop = _PAIRING.get("loop")
    if not pairing or not loop:
        raise RuntimeError("No pairing in progress — start pairing first")

    async def finish():
        pairing.pin(pin)
        await pairing.finish()
        service = pairing.service
        creds = getattr(service, "credentials", None) or ""
        return str(creds)

    future = asyncio.run_coroutine_threadsafe(finish(), loop)
    credentials = future.result(timeout=60)
    identifier = _PAIRING.get("identifier") or ""
    _PAIRING["awaiting_pin"] = False
    _PAIRING["handler"] = None
    return {
        "ok": True,
        "identifier": identifier,
        "credentials": credentials,
    }


def pair_cancel() -> None:
    _PAIRING["awaiting_pin"] = False
    pairing = _PAIRING.get("handler")
    loop = _PAIRING.get("loop")
    if pairing and loop:
        try:
            fut = asyncio.run_coroutine_threadsafe(pairing.close(), loop)
            fut.result(timeout=5)
        except Exception:
            pass
    _PAIRING["handler"] = None
    _PAIRING["loop"] = None
    _PAIRING["identifier"] = ""
