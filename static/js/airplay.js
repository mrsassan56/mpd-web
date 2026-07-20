/** AirPlay cast UI — scan, select, pair, play (parallel to DLNA). */

let airplaySelected = {identifier: "", address: "", name: "", has_credentials: false};
let airplayDevicesCache = [];

function hasAirplayTarget() {
    return !!(airplaySelected && (airplaySelected.identifier || airplaySelected.address));
}

function airplayTargetLabel() {
    if (!hasAirplayTarget()) return "No AirPlay target";
    return airplaySelected.name || airplaySelected.address || airplaySelected.identifier || "AirPlay";
}

async function refreshAirplayState() {
    try {
        const data = await airplayDevices();
        airplayDevicesCache = data.devices || [];
        airplaySelected = data.selected || {
            identifier: "", address: "", name: "", has_credentials: false
        };
        syncAirplayUi();
        return data;
    } catch (e) {
        syncAirplayUi();
        throw e;
    }
}

function syncAirplayUi() {
    const labelEls = document.querySelectorAll("[data-airplay-label]");
    labelEls.forEach(function(el) {
        el.innerText = airplayTargetLabel();
    });

    const bar = document.getElementById("airplayBarControls");
    if (bar) bar.style.display = hasAirplayTarget() ? "flex" : "none";

    fillAirplaySelect();

    const list = document.getElementById("airplayDeviceList");
    if (list && list.dataset.bound === "1") {
        renderAirplayDeviceList(list, airplayDevicesCache);
    }

    if (typeof syncDlnaUi === "function") {
        try { syncDlnaUi(); } catch (e) {}
    }
}

function fillAirplaySelect() {
    const sel = document.getElementById("airplaySelect");
    if (!sel) return;
    clearElement(sel);

    const off = document.createElement("option");
    off.value = "";
    off.innerText = "— Off —";
    sel.appendChild(off);

    const devices = airplayDevicesCache.slice();
    if (hasAirplayTarget()) {
        const inList = devices.some(function(d) {
            return (d.identifier && d.identifier === airplaySelected.identifier) ||
                (d.address && d.address === airplaySelected.address);
        });
        if (!inList) {
            devices.unshift({
                identifier: airplaySelected.identifier || "",
                address: airplaySelected.address || "",
                name: airplaySelected.name || "AirPlay device",
                model: ""
            });
        }
    }

    devices.forEach(function(d) {
        const opt = document.createElement("option");
        opt.value = d.identifier || d.address || "";
        opt.innerText = d.name || d.address || "AirPlay";
        opt.dataset.identifier = d.identifier || "";
        opt.dataset.address = d.address || "";
        opt.dataset.name = d.name || "";
        sel.appendChild(opt);
    });

    if (hasAirplayTarget()) {
        const match = airplaySelected.identifier || airplaySelected.address || "";
        sel.value = match;
        if (sel.value !== match) {
            for (let i = 0; i < sel.options.length; i++) {
                const o = sel.options[i];
                if (o.dataset.identifier === airplaySelected.identifier ||
                    o.dataset.address === airplaySelected.address) {
                    sel.selectedIndex = i;
                    break;
                }
            }
        }
    }
}

async function onAirplaySelectChange() {
    const sel = document.getElementById("airplaySelect");
    if (!sel) return;
    const opt = sel.options[sel.selectedIndex];
    if (!opt || !opt.value) {
        await clearAirplayTarget();
        return;
    }
    try {
        const payload = {
            identifier: opt.dataset.identifier || opt.value,
            address: opt.dataset.address || "",
            name: opt.dataset.name || opt.innerText
        };
        const res = await airplaySelect(payload);
        airplaySelected = res.selected || payload;
        rememberLocalAirplayDevice(airplaySelected);
        syncAirplayUi();
        showAirplayMsg("AirPlay → " + airplayTargetLabel() + "…");
        await castCurrentSong();
    } catch (e) {
        showAirplayMsg("Select failed: " + (e.message || String(e)));
    }
}

function rememberLocalAirplayDevice(device) {
    if (!device || !(device.identifier || device.address)) return;
    const exists = airplayDevicesCache.some(function(d) {
        return (d.identifier && d.identifier === device.identifier) ||
            (d.address && d.address === device.address);
    });
    if (!exists) {
        airplayDevicesCache.unshift({
            identifier: device.identifier || "",
            address: device.address || "",
            name: device.name || "AirPlay device",
            model: ""
        });
    }
}

function renderAirplayDeviceList(box, devices) {
    if (!box) return;
    clearElement(box);
    box.dataset.bound = "1";
    if (!devices || !devices.length) {
        box.appendChild(makeMeta("No devices yet — tap Scan AirPlay."));
        return;
    }
    devices.forEach(function(d) {
        const row = document.createElement("div");
        row.className = "item airplay-device-row";
        const selected = hasAirplayTarget() && (
            (d.identifier && d.identifier === airplaySelected.identifier) ||
            (d.address && d.address === airplaySelected.address)
        );
        if (selected) row.classList.add("dlna-selected");

        const left = document.createElement("div");
        left.className = "item-main";
        const name = document.createElement("div");
        name.className = "item-name";
        name.innerText = d.name || "AirPlay device";
        left.appendChild(name);
        const meta = document.createElement("div");
        meta.className = "meta";
        const bits = [d.model, d.address];
        if (d.services && d.services.length) bits.push(d.services.join(", "));
        meta.innerText = bits.filter(Boolean).join(" · ");
        left.appendChild(meta);

        const actions = document.createElement("div");
        actions.className = "actions";

        const useBtn = makeButton(selected ? "Selected" : "Use & play", async function() {
            try {
                const payload = {
                    identifier: d.identifier || "",
                    address: d.address || "",
                    name: d.name || ""
                };
                const res = await airplaySelect(payload);
                airplaySelected = res.selected || payload;
                rememberLocalAirplayDevice(airplaySelected);
                syncAirplayUi();
                renderAirplayDeviceList(box, airplayDevicesCache.length ? airplayDevicesCache : devices);
                showAirplayMsg("AirPlay → " + airplayTargetLabel() + "…");
                await castCurrentSong();
            } catch (e) {
                showAirplayMsg("Select failed: " + (e.message || String(e)));
            }
        });
        if (selected) useBtn.className = "pill accent";
        actions.appendChild(useBtn);

        const pairBtn = makeButton("Pair", async function() {
            await startAirplayPair(d);
        });
        actions.appendChild(pairBtn);

        row.appendChild(left);
        row.appendChild(actions);
        box.appendChild(row);
    });
}

function showAirplayMsg(text) {
    const msg = document.getElementById("airplayMsg") || document.getElementById("dlnaMsg") ||
        document.getElementById("settingsMsg") || document.getElementById("playerActionMsg");
    if (msg) {
        msg.innerText = text || "";
        if (text) {
            setTimeout(function() {
                if (msg.innerText === text) msg.innerText = "";
            }, 4500);
        }
    }
}

async function scanAirplayDevices() {
    const msg = document.getElementById("airplayMsg");
    if (msg) msg.innerText = "Scanning LAN for AirPlay devices…";
    try {
        const data = await airplayScan(6);
        airplayDevicesCache = data.devices || [];
        const list = document.getElementById("airplayDeviceList");
        renderAirplayDeviceList(list, airplayDevicesCache);
        if (msg) msg.innerText = (airplayDevicesCache.length || 0) + " AirPlay device(s) found";
        syncAirplayUi();
    } catch (e) {
        if (msg) msg.innerText = "Scan failed: " + (e.message || String(e));
    }
}

async function clearAirplayTarget() {
    try {
        await airplaySelect({identifier: "", address: "", name: ""});
        airplaySelected = {identifier: "", address: "", name: "", has_credentials: false};
        syncAirplayUi();
        const list = document.getElementById("airplayDeviceList");
        if (list) renderAirplayDeviceList(list, airplayDevicesCache);
        showAirplayMsg("AirPlay target cleared");
    } catch (e) {
        showAirplayMsg("Clear failed: " + (e.message || String(e)));
    }
}

async function airplayPlayFile(file, meta) {
    meta = meta || {};
    if (!file) {
        showAirplayMsg("Nothing to cast");
        return;
    }
    if (!hasAirplayTarget()) {
        showAirplayMsg("Select an AirPlay device first (Settings)");
        return;
    }
    showAirplayMsg("AirPlaying…");
    try {
        const res = await airplayPlay(file, meta);
        showAirplayMsg("AirPlay “" + (res.title || file) + "” → " + (res.device || airplayTargetLabel()));
    } catch (e) {
        showAirplayMsg("AirPlay failed: " + (e.message || String(e)));
    }
}

async function airplayTransport(action) {
    try {
        await airplayCmd(action);
        showAirplayMsg("AirPlay " + action);
    } catch (e) {
        showAirplayMsg("AirPlay " + action + " failed: " + (e.message || String(e)));
    }
}

async function startAirplayPair(device) {
    device = device || airplaySelected;
    if (!device || !(device.identifier || device.address)) {
        showAirplayMsg("Pick a device first");
        return;
    }
    try {
        await airplaySelect({
            identifier: device.identifier || "",
            address: device.address || "",
            name: device.name || ""
        });
        showAirplayMsg("Starting pair — enter the PIN shown on the device…");
        await airplayPairStart({
            identifier: device.identifier || "",
            address: device.address || ""
        });
        const pin = prompt("Enter the AirPlay PIN shown on “" + (device.name || "device") + "”:");
        if (!pin) {
            await airplayPairCancel();
            showAirplayMsg("Pairing cancelled");
            return;
        }
        await airplayPairFinish(pin);
        airplaySelected.has_credentials = true;
        showAirplayMsg("Paired with " + (device.name || "device"));
        syncAirplayUi();
    } catch (e) {
        try { await airplayPairCancel(); } catch (e2) {}
        showAirplayMsg("Pair failed: " + (e.message || String(e)));
    }
}

async function loadAirplaySettingsPanel() {
    const list = document.getElementById("airplayDeviceList");
    if (list) list.dataset.bound = "1";
    try {
        await refreshAirplayState();
        if (list) renderAirplayDeviceList(list, airplayDevicesCache);
    } catch (e) {}
}

window.scanAirplayDevices = scanAirplayDevices;
window.clearAirplayTarget = clearAirplayTarget;
window.onAirplaySelectChange = onAirplaySelectChange;
window.airplayTransport = airplayTransport;
window.airplayPlayFile = airplayPlayFile;
window.startAirplayPair = startAirplayPair;
window.loadAirplaySettingsPanel = loadAirplaySettingsPanel;
window.hasAirplayTarget = hasAirplayTarget;
window.refreshAirplayState = refreshAirplayState;
window.airplayTargetLabel = airplayTargetLabel;
