async function loadSettingsForm() {
    const box = document.getElementById("settingsPlayers");
    if (box) {
        clearElement(box);
        box.appendChild(makeMeta("Loading..."));
    }

    try {
        const data = await api("/api/settings");
        if (box) {
            clearElement(box);
            renderSettingsPlayers(data.players || [], data.default_player || "");
        }
        if (typeof loadDlnaSettingsPanel === "function") {
            loadDlnaSettingsPanel();
        }
        if (typeof loadAirplaySettingsPanel === "function") {
            loadAirplaySettingsPanel();
        }
        if (typeof loadListenBrainzSettings === "function") {
            loadListenBrainzSettings(data.listenbrainz);
        }
        await loadPlaybackSettings();
    } catch (e) {
        if (box) {
            clearElement(box);
            box.appendChild(makeMeta("Error: " + (e.message || String(e))));
        }
        await loadPlaybackSettings();
    }
}

async function loadPlaybackSettings() {
    const xfade = document.getElementById("xfadeSeconds");
    const mixOn = document.getElementById("mixrampEnabled");
    const mixDb = document.getElementById("mixrampDb");
    if (!xfade && !mixOn) return;
    try {
        const data = await api("/api/crossfade");
        if (xfade) xfade.value = data.xfade != null ? data.xfade : 0;
        const delay = String(data.mixrampdelay == null ? "nan" : data.mixrampdelay).toLowerCase();
        if (mixOn) mixOn.checked = delay !== "nan";
        if (mixDb) {
            mixDb.value = data.mixrampdb != null && data.mixrampdb !== "" ? data.mixrampdb : -17;
        }
    } catch (e) {
        /* ignore */
    }
}

async function savePlaybackSettings() {
    const msg = document.getElementById("playbackMsg") || document.getElementById("settingsMsg");
    const seconds = document.getElementById("xfadeSeconds")
        ? Number(document.getElementById("xfadeSeconds").value || 0)
        : 0;
    const mixOn = document.getElementById("mixrampEnabled")
        ? document.getElementById("mixrampEnabled").checked
        : false;
    const mixDb = document.getElementById("mixrampDb")
        ? Number(document.getElementById("mixrampDb").value || -17)
        : -17;
    if (msg) msg.innerText = "Saving playback…";
    try {
        const payload = {seconds: seconds};
        if (mixOn) {
            payload.mixrampdb = mixDb;
            payload.mixrampdelay = 1;
        } else {
            payload.mixrampdelay = "nan";
        }
        await api("/api/crossfade", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify(payload)
        });
        if (msg) msg.innerText = "Playback settings saved";
        setTimeout(function() { if (msg) msg.innerText = ""; }, 2500);
    } catch (e) {
        if (msg) msg.innerText = "Error: " + (e.message || String(e));
    }
}

async function loadListenBrainzSettings(prefetched) {
    const enabled = document.getElementById("lbEnabled");
    const user = document.getElementById("lbUsername");
    const hint = document.getElementById("lbHint");
    let data = prefetched;
    if (!data) {
        try {
            data = await api("/api/settings/listenbrainz");
        } catch (e) {
            if (hint) hint.innerText = "Could not load ListenBrainz settings";
            return;
        }
    }
    if (enabled) enabled.checked = !!data.enabled;
    if (user) user.value = data.username || "";
    if (hint) {
        hint.innerText = data.has_token
            ? ("Token saved" + (data.token_hint ? " (" + data.token_hint + ")" : ""))
            : "No token saved yet";
    }
}

async function saveListenBrainzSettings() {
    const msg = document.getElementById("settingsMsg");
    const payload = {
        enabled: !!(document.getElementById("lbEnabled") && document.getElementById("lbEnabled").checked),
        username: document.getElementById("lbUsername")
            ? document.getElementById("lbUsername").value.trim()
            : "",
        token: document.getElementById("lbToken")
            ? document.getElementById("lbToken").value.trim()
            : ""
    };
    if (msg) msg.innerText = "Saving ListenBrainz…";
    try {
        await api("/api/settings/listenbrainz", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify(payload)
        });
        const tokenInput = document.getElementById("lbToken");
        if (tokenInput) tokenInput.value = "";
        await loadListenBrainzSettings();
        if (msg) msg.innerText = "ListenBrainz settings saved";
        setTimeout(function() { if (msg) msg.innerText = ""; }, 2500);
    } catch (e) {
        if (msg) msg.innerText = "Error: " + (e.message || String(e));
    }
}

function renderSettingsPlayers(players, defaultKey) {
    const box = document.getElementById("settingsPlayers");
    if (!box) return;
    clearElement(box);

    players.forEach(function(p) {
        box.appendChild(makeSettingsCard(p, p.key === defaultKey));
    });

    if (!players.length) {
        box.appendChild(makeSettingsCard({
            key: "player1",
            name: "Player",
            host: "",
            port: 6600,
            password: "",
            music_root: "/store"
        }, true));
    }
}

function makeSettingsCard(p, isDefault) {
    const card = document.createElement("div");
    card.className = "settings-card";
    card.dataset.key = p.key || "";

    const head = document.createElement("div");
    head.className = "settings-card-head";
    head.innerHTML = "<strong>" + (p.name || p.key || "Output") + "</strong>" +
        (isDefault ? " <span class=\"settings-default-badge\">default</span>" : "");
    card.appendChild(head);

    card.appendChild(settingsField("Key (internal)", "key", p.key || "", "player id e.g. ifi"));
    card.appendChild(settingsField("Name", "name", p.name || "", "shown in menu"));
    card.appendChild(settingsField("Host / IP", "host", p.host || "", "192.168.1.10"));
    card.appendChild(settingsField("Port", "port", p.port || 6600, "6600"));
    card.appendChild(settingsField("Password", "password", p.password || "", "optional"));
    card.appendChild(settingsField("Music root", "music_root", p.music_root || "", "/store on Pi"));

    const defaultRow = document.createElement("label");
    defaultRow.className = "settings-default";
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "defaultPlayer";
    radio.value = p.key || "";
    radio.checked = !!isDefault;
    defaultRow.appendChild(radio);
    defaultRow.appendChild(document.createTextNode(" Default on startup"));
    card.appendChild(defaultRow);

    const actions = document.createElement("div");
    actions.className = "settings-card-actions";
    actions.appendChild(makeButton("Test connection", function() {
        testSettingsCard(card);
    }));
    actions.appendChild(makeButton("Remove", function() {
        if (document.querySelectorAll(".settings-card").length <= 1) {
            alert("Keep at least one player.");
            return;
        }
        card.remove();
    }));
    card.appendChild(actions);

    return card;
}

function settingsField(label, field, value, placeholder) {
    const row = document.createElement("div");
    row.className = "settings-field";
    const lbl = document.createElement("label");
    lbl.innerText = label;
    const input = document.createElement("input");
    input.dataset.field = field;
    input.value = value != null ? value : "";
    if (placeholder) input.placeholder = placeholder;
    if (field === "port") input.type = "number";
    if (field === "password") input.type = "password";
    row.appendChild(lbl);
    row.appendChild(input);
    return row;
}

function collectSettingsPlayers() {
    const cards = document.querySelectorAll(".settings-card");
    const players = [];
    let defaultPlayer = "";

    const defaultRadio = document.querySelector('input[name="defaultPlayer"]:checked');
    if (defaultRadio) defaultPlayer = defaultRadio.value;

    cards.forEach(function(card) {
        const item = {key: "", name: "", host: "", port: 6600, password: "", music_root: ""};
        card.querySelectorAll("input[data-field]").forEach(function(inp) {
            item[inp.dataset.field] = inp.value.trim();
        });
        if (!item.key) {
            item.key = item.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "player";
        }
        try {
            item.port = parseInt(item.port, 10) || 6600;
        } catch (e) {
            item.port = 6600;
        }
        if (defaultRadio && card.contains(defaultRadio)) {
            defaultPlayer = item.key;
        }
        players.push(item);
    });

    return {players: players, default_player: defaultPlayer};
}

async function saveSettingsPlayers() {
    const payload = collectSettingsPlayers();
    const msg = document.getElementById("settingsMsg");
    if (msg) msg.innerText = "Saving…";

    try {
        await api("/api/settings/players", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify(payload)
        });
        if (msg) msg.innerText = "Saved. Reloading players…";
        if (typeof loadPlayers === "function") await loadPlayers();
        if (typeof syncOutputSelect === "function") syncOutputSelect();
        loadSettingsForm();
        setTimeout(function() {
            if (msg) msg.innerText = "";
        }, 2500);
    } catch (e) {
        if (msg) msg.innerText = "Error: " + (e.message || String(e));
    }
}

async function testSettingsCard(card) {
    const item = {host: "", port: 6600, password: ""};
    card.querySelectorAll("input[data-field]").forEach(function(inp) {
        if (inp.dataset.field in item) item[inp.dataset.field] = inp.value.trim();
    });
    try {
        item.port = parseInt(item.port, 10) || 6600;
    } catch (e) {
        item.port = 6600;
    }

    const msg = document.getElementById("settingsMsg");
    if (msg) msg.innerText = "Testing " + item.host + "…";

    try {
        const res = await api("/api/settings/test", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify(item)
        });
        if (msg) msg.innerText = "OK — MPD at " + item.host + " is " + (res.state || "reachable");
    } catch (e) {
        if (msg) msg.innerText = "Failed: " + (e.message || String(e));
    }
}

function addSettingsPlayer() {
    const box = document.getElementById("settingsPlayers");
    if (!box) return;
    const n = box.querySelectorAll(".settings-card").length + 1;
    box.appendChild(makeSettingsCard({
        key: "player" + n,
        name: "Player " + n,
        host: "",
        port: 6600,
        password: "",
        music_root: "/store"
    }, false));
}

window.loadSettingsForm = loadSettingsForm;
window.saveSettingsPlayers = saveSettingsPlayers;
window.addSettingsPlayer = addSettingsPlayer;
window.testSettingsCard = testSettingsCard;
window.saveListenBrainzSettings = saveListenBrainzSettings;
window.loadListenBrainzSettings = loadListenBrainzSettings;
window.loadPlaybackSettings = loadPlaybackSettings;
window.savePlaybackSettings = savePlaybackSettings;
