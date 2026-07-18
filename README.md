# mpd-web

A lightweight **web controller for [MPD](https://www.musicpd.org/)** (Music Player Daemon).  
Control your hi‑fi / streamer from a phone or desktop browser on your local network.

**Live UI**

| View | URL |
|------|-----|
| Desktop | `http://<host>:5000/` |
| Mobile | `http://<host>:5000/m` |

---

## Features

- **Browse** library by albums, artists, or folders
- **Search** tracks / albums / artists
- **Queue** with drag-and-drop reorder (desktop)
- **Playlists**, including Liked Songs
- **Local & smart radio** (library tags; optional ListenBrainz)
- **Sleep timer** (30 / 60 / 120 / 180 minutes)
- **Crossfade / MixRamp** settings
- **DLNA cast** to TVs and network renderers
- **Browser listen** — play on the device that has the page open (independent of the room player)
- **Dark / light** theme; optional cover art toggle (mobile)

Music still plays through your **MPD outputs** (DAC, streamer, speakers). This app is a controller (plus optional phone/browser streaming).

---

## Requirements

- Python 3.10+ recommended
- One or more MPD servers reachable on the LAN (`host:6600`)
- Music files readable from this machine if you use:
  - album/folder cover art from disk
  - DLNA streaming
  - browser listen  

  Set each player’s `music_root` to that path (e.g. `/store` or an NFS mount).

---

## Quick start

```bash
git clone https://github.com/mrsassan56/mpd-web.git
cd mpd-web

python3 -m venv venv
source venv/bin/activate   # Windows: venv\Scripts\activate
pip install -r requirements.txt
```

### Bind address

By default `app.py` may listen on a fixed LAN IP. For a generic install, set the last line to:

```python
app.run(host="0.0.0.0", port=5000, debug=False, threaded=True)
```

Then:

```bash
python3 app.py
```

Open `http://<your-server-ip>:5000/` (desktop) or `…/m` (mobile).

---

## Configuration

On first run the app creates `config.json` (not committed — keep secrets local).

Example:

```json
{
  "default_player": "streamer",
  "players": {
    "streamer": {
      "name": "Living room",
      "host": "192.168.1.50",
      "port": 6600,
      "password": null,
      "music_root": "/path/to/music"
    }
  },
  "dlna": {
    "public_base": "http://192.168.1.10:5000",
    "selected_udn": "",
    "selected_location": "",
    "selected_name": ""
  },
  "listenbrainz": {
    "enabled": false,
    "token": "",
    "username": ""
  }
}
```

You can also edit players, DLNA, and ListenBrainz from **Settings** in the UI.

| Field | Meaning |
|-------|---------|
| `host` / `port` | MPD TCP address |
| `music_root` | Absolute path on *this* machine to the same library MPD uses |
| `dlna.public_base` | LAN URL of this web app (TVs must reach it to cast) |

---

## systemd (Linux / Raspberry Pi)

Edit paths in [`mpd-web.service`](mpd-web.service) if your install is not `/root/mpd-web`, then:

```bash
sudo ./install-service.sh
# or manually:
sudo cp mpd-web.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now mpd-web
```

Manual start without systemd: `./start.sh` (expects `./venv`).

---

## Browser listen (B)

1. Tap **B** (mobile) or choose **This browser** in Output.
2. Play albums / folders / radio as usual — audio streams to *this* device.
3. The room MPD queue is left alone (independent listening).

Needs `music_root` and formats your browser can decode (FLAC/MP3/AAC usually OK; DSD often not).

**Note:** Mobile browsers may pause when the screen locks; that is an OS limitation, not MPD.

---

## DLNA cast

1. Settings → set **Public base URL** to this server (`http://<lan-ip>:5000`).
2. Scan and select a renderer.
3. Use the cast control on Now Playing / tracks.

The Pi (or host) must be able to serve files under `music_root` via `/api/dlna/stream`.

---

## Project layout

```
app.py              Flask API + MPD bridge
dlna_cast.py        UPnP / DLNA helpers
static/desktop/     Desktop UI
static/mobile/      Mobile UI (/m)
static/js/          Shared front-end modules
requirements.txt
mpd-web.service     systemd unit
```

---

## Security

- Intended for a **trusted home LAN**. Do not expose port 5000 to the public internet without a reverse proxy, auth, and HTTPS.
- Do not commit `config.json` if it contains passwords or tokens.

---

## License

Use and modify freely for personal or community projects. Attribution appreciated but not required.

---

## Credits

Built around [python-mpd2](https://github.com/Mic92/python-mpd2), Flask, and [async-upnp-client](https://github.com/StevenLooman/async_upnp_client) for DLNA.
