async function parseApiError(res) {
    const text = await res.text();
    try {
        const data = JSON.parse(text);
        return data.error || data.message || text;
    } catch (e) {
        if (text.indexOf("<html") >= 0 || text.indexOf("Werkzeug") >= 0) {
            if (text.indexOf("TimeoutError") >= 0 || text.indexOf("timed out") >= 0) {
                return "MPD connection timed out — try Local radio or check the player is reachable";
            }
            return "Server error — please try again";
        }
        return text.length > 180 ? text.slice(0, 180) + "…" : text;
    }
}

async function api(path, options) {
    options = options || {};
    const res = await fetch(path, options);
    if (!res.ok) {
        throw new Error(await parseApiError(res));
    }
    const ct = res.headers.get("content-type") || "";
    if (ct.indexOf("application/json") >= 0) {
        return await res.json();
    }
    return null;
}

async function apiSearch(params) {
    const q = new URLSearchParams(params);
    return api("/api/search?" + q.toString());
}

async function apiPlaylist(name) {
    return api("/api/playlist?name=" + encodeURIComponent(name));
}

async function dlnaDevices() {
    return api("/api/dlna/devices");
}

async function dlnaScan(timeout) {
    return api("/api/dlna/scan", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({timeout: timeout || 5})
    });
}

async function dlnaSelect(payload) {
    return api("/api/dlna/select", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(payload || {})
    });
}

async function dlnaPlay(file, meta) {
    meta = meta || {};
    return api("/api/dlna/play", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({
            file: file,
            title: meta.title || "",
            artist: meta.artist || "",
            album: meta.album || ""
        })
    });
}

async function dlnaCmd(action, extra) {
    const body = Object.assign({action: action}, extra || {});
    return api("/api/dlna/cmd", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(body)
    });
}

async function airplayDevices() {
    return api("/api/airplay/devices");
}

async function airplayScan(timeout) {
    return api("/api/airplay/scan", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({timeout: timeout || 6})
    });
}

async function airplaySelect(payload) {
    return api("/api/airplay/select", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(payload || {})
    });
}

async function airplayPlay(file, meta) {
    meta = meta || {};
    return api("/api/airplay/play", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({
            file: file,
            title: meta.title || "",
            artist: meta.artist || "",
            album: meta.album || ""
        })
    });
}

async function airplayCmd(action, extra) {
    const body = Object.assign({action: action}, extra || {});
    return api("/api/airplay/cmd", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(body)
    });
}

async function airplayPairStart(payload) {
    return api("/api/airplay/pair/start", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(payload || {})
    });
}

async function airplayPairFinish(pin) {
    return api("/api/airplay/pair/finish", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({pin: pin})
    });
}

async function airplayPairCancel() {
    return api("/api/airplay/pair/cancel", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: "{}"
    });
}

async function apiRadioStart(mode, count) {
    return api("/api/radio/start", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({mode: mode || "local", count: count || 15, replace: false})
    });
}

async function moveQueueItem(fromPos, toPos) {
    return api("/api/movequeue", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({from: fromPos, to: toPos})
    });
}

async function apiRecent() {
    return api("/api/recent");
}
