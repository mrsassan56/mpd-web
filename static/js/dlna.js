/** Shared DLNA cast UI state and helpers. */

let dlnaSelected = {udn: "", location: "", name: ""};
let dlnaDevicesCache = [];

function hasDlnaTarget() {
    return !!(dlnaSelected && dlnaSelected.location);
}

function dlnaTargetLabel() {
    if (!hasDlnaTarget()) return "No DLNA target";
    return dlnaSelected.name || dlnaSelected.location || "DLNA";
}

async function refreshDlnaState() {
    try {
        const data = await dlnaDevices();
        dlnaDevicesCache = data.devices || [];
        dlnaSelected = data.selected || {udn: "", location: "", name: ""};
        syncDlnaUi(data.public_base || "");
        return data;
    } catch (e) {
        syncDlnaUi("");
        throw e;
    }
}

function syncDlnaUi(publicBase) {
    const labelEls = document.querySelectorAll("[data-dlna-label]");
    labelEls.forEach(function(el) {
        el.innerText = dlnaTargetLabel();
    });

    const castBtns = document.querySelectorAll("[data-dlna-needs-target]");
    castBtns.forEach(function(el) {
        el.disabled = !hasDlnaTarget();
        el.classList.toggle("cast-active", hasDlnaTarget());
        el.title = hasDlnaTarget()
            ? ("Cast to " + dlnaTargetLabel())
            : "Select a DLNA device first (Settings or Cast menu)";
    });

    const bar = document.getElementById("dlnaBarControls");
    if (bar) bar.style.display = hasDlnaTarget() ? "flex" : "none";

    const chip = document.getElementById("castChip");
    if (chip) chip.style.display = hasDlnaTarget() ? "inline-flex" : "none";

    const baseInput = document.getElementById("dlnaPublicBase");
    if (baseInput && publicBase != null && document.activeElement !== baseInput) {
        if (!baseInput.value) baseInput.value = publicBase;
    }

    fillCastSelect();

    const list = document.getElementById("dlnaDeviceList");
    if (list && list.dataset.bound === "1") {
        renderDlnaDeviceList(list, dlnaDevicesCache);
    }
}

function fillCastSelect() {
    const sel = document.getElementById("castSelect");
    if (!sel) return;
    const prev = sel.value;
    clearElement(sel);

    const off = document.createElement("option");
    off.value = "";
    off.innerText = "— Off —";
    sel.appendChild(off);

    const devices = dlnaDevicesCache.slice();
    // Ensure selected device is listed even if not in last scan
    if (hasDlnaTarget()) {
        const inList = devices.some(function(d) {
            return (d.udn && d.udn === dlnaSelected.udn) ||
                (d.location && d.location === dlnaSelected.location);
        });
        if (!inList) {
            devices.unshift({
                udn: dlnaSelected.udn || "",
                location: dlnaSelected.location || "",
                name: dlnaSelected.name || "DLNA device",
                model: ""
            });
        }
    }

    devices.forEach(function(d) {
        const opt = document.createElement("option");
        opt.value = d.location || d.udn || "";
        opt.innerText = d.name || d.location || "DLNA";
        opt.dataset.udn = d.udn || "";
        opt.dataset.location = d.location || "";
        opt.dataset.name = d.name || "";
        sel.appendChild(opt);
    });

    if (hasDlnaTarget()) {
        const match = dlnaSelected.location || dlnaSelected.udn || "";
        sel.value = match;
        if (sel.value !== match) {
            // fallback: pick by scanning options
            for (let i = 0; i < sel.options.length; i++) {
                const o = sel.options[i];
                if (o.dataset.location === dlnaSelected.location ||
                    o.dataset.udn === dlnaSelected.udn) {
                    sel.selectedIndex = i;
                    break;
                }
            }
        }
    } else if (prev && !hasDlnaTarget()) {
        sel.value = "";
    }
}

async function onCastSelectChange() {
    const sel = document.getElementById("castSelect");
    if (!sel) return;
    const opt = sel.options[sel.selectedIndex];
    if (!opt || !opt.value) {
        await clearDlnaTarget();
        return;
    }
    try {
        const baseEl = document.getElementById("dlnaPublicBase");
        const payload = {
            udn: opt.dataset.udn || "",
            location: opt.dataset.location || opt.value,
            name: opt.dataset.name || opt.innerText
        };
        if (baseEl && baseEl.value.trim()) {
            payload.public_base = baseEl.value.trim();
        }
        const res = await dlnaSelect(payload);
        dlnaSelected = res.selected || payload;
        // keep in cache
        rememberLocalDevice(dlnaSelected);
        syncDlnaUi(res.public_base || "");
        showDlnaMsg("Casting to " + dlnaTargetLabel() + "…");
        await castCurrentSong();
    } catch (e) {
        showDlnaMsg("Select failed: " + (e.message || String(e)));
    }
}

function rememberLocalDevice(device) {
    if (!device || !device.location) return;
    const key = device.udn || device.location;
    const exists = dlnaDevicesCache.some(function(d) {
        return (d.udn && d.udn === device.udn) || (d.location === device.location);
    });
    if (!exists) {
        dlnaDevicesCache.unshift({
            udn: device.udn || "",
            location: device.location || "",
            name: device.name || "DLNA device",
            model: ""
        });
    }
}

function renderDlnaDeviceList(box, devices) {
    if (!box) return;
    clearElement(box);
    box.dataset.bound = "1";
    if (!devices || !devices.length) {
        box.appendChild(makeMeta("No devices yet — tap Scan."));
        return;
    }
    devices.forEach(function(d) {
        const row = document.createElement("div");
        row.className = "item dlna-device-row";
        const selected = hasDlnaTarget() && (
            (d.udn && d.udn === dlnaSelected.udn) ||
            (d.location && d.location === dlnaSelected.location)
        );
        if (selected) row.classList.add("dlna-selected");

        const left = document.createElement("div");
        left.className = "item-main";
        const name = document.createElement("div");
        name.className = "item-name";
        name.innerText = d.name || "DLNA device";
        left.appendChild(name);
        const meta = document.createElement("div");
        meta.className = "meta";
        meta.innerText = [d.model, d.location].filter(Boolean).join(" · ");
        left.appendChild(meta);

        const actions = document.createElement("div");
        actions.className = "actions";
        const btn = makeButton(selected ? "Selected" : "Use & play", async function() {
            try {
                const baseEl = document.getElementById("dlnaPublicBase");
                const payload = {
                    udn: d.udn || "",
                    location: d.location || "",
                    name: d.name || ""
                };
                if (baseEl && baseEl.value.trim()) {
                    payload.public_base = baseEl.value.trim();
                }
                const res = await dlnaSelect(payload);
                dlnaSelected = res.selected || payload;
                rememberLocalDevice(dlnaSelected);
                syncDlnaUi(res.public_base || "");
                renderDlnaDeviceList(box, dlnaDevicesCache.length ? dlnaDevicesCache : devices);
                showDlnaMsg("Casting to " + dlnaTargetLabel() + "…");
                await castCurrentSong();
            } catch (e) {
                showDlnaMsg("Select failed: " + (e.message || String(e)));
            }
        });
        if (selected) btn.className = "pill accent";
        actions.appendChild(btn);

        row.appendChild(left);
        row.appendChild(actions);
        box.appendChild(row);
    });
}

function showDlnaMsg(text) {
    const msg = document.getElementById("dlnaMsg") || document.getElementById("settingsMsg") ||
        document.getElementById("playerActionMsg");
    if (msg) {
        msg.innerText = text || "";
        if (text) {
            setTimeout(function() {
                if (msg.innerText === text) msg.innerText = "";
            }, 3500);
        }
    }
}

async function scanDlnaDevices() {
    const msg = document.getElementById("dlnaMsg");
    if (msg) msg.innerText = "Scanning LAN for DLNA devices…";
    try {
        const data = await dlnaScan(5);
        dlnaDevicesCache = data.devices || [];
        const list = document.getElementById("dlnaDeviceList");
        renderDlnaDeviceList(list, dlnaDevicesCache);
        if (msg) msg.innerText = (dlnaDevicesCache.length || 0) + " device(s) found";
        syncDlnaUi();
    } catch (e) {
        if (msg) msg.innerText = "Scan failed: " + (e.message || String(e));
    }
}

async function saveDlnaPublicBase() {
    const baseEl = document.getElementById("dlnaPublicBase");
    if (!baseEl) return;
    try {
        const res = await dlnaSelect({
            udn: dlnaSelected.udn || "",
            location: dlnaSelected.location || "",
            name: dlnaSelected.name || "",
            public_base: baseEl.value.trim()
        });
        dlnaSelected = res.selected || dlnaSelected;
        showDlnaMsg("Public base saved");
        syncDlnaUi(res.public_base || baseEl.value.trim());
    } catch (e) {
        showDlnaMsg("Save failed: " + (e.message || String(e)));
    }
}

async function clearDlnaTarget() {
    try {
        await dlnaSelect({udn: "", location: "", name: ""});
        dlnaSelected = {udn: "", location: "", name: ""};
        syncDlnaUi();
        const list = document.getElementById("dlnaDeviceList");
        if (list) renderDlnaDeviceList(list, dlnaDevicesCache);
        showDlnaMsg("DLNA target cleared");
    } catch (e) {
        showDlnaMsg(e.message || String(e));
    }
}

async function castFile(file, meta) {
    if (!file) return;
    if (!hasDlnaTarget()) {
        showDlnaMsg("Select a DLNA device first (Settings)");
        return;
    }
    showDlnaMsg("Casting…");
    try {
        const res = await dlnaPlay(file, meta || {});
        showDlnaMsg("Casting “" + (res.title || file) + "” → " + (res.device || dlnaTargetLabel()));
    } catch (e) {
        showDlnaMsg("Cast failed: " + (e.message || String(e)));
    }
}

async function castCurrentSong() {
    if (typeof currentSongMeta === "undefined") {
        showDlnaMsg("Nothing playing");
        return;
    }
    // Prefer file path from last status via setCurrentTrack / window
    const file = window._dlnaCurrentFile || "";
    if (!file) {
        showDlnaMsg("No current track file");
        return;
    }
    await castFile(file, {
        title: document.getElementById("title") ? document.getElementById("title").innerText : "",
        artist: document.getElementById("artist") ? document.getElementById("artist").innerText : "",
        album: currentSongMeta.album || ""
    });
}

function setDlnaCurrentFile(file) {
    window._dlnaCurrentFile = file || "";
}

async function dlnaTransport(action) {
    try {
        await dlnaCmd(action);
        showDlnaMsg("DLNA " + action);
    } catch (e) {
        showDlnaMsg("DLNA " + action + " failed: " + (e.message || String(e)));
    }
}

function makeCastButton(file, meta) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cast-remote-btn cast-row-btn";
    btn.setAttribute("data-dlna-needs-target", "1");
    btn.disabled = !hasDlnaTarget();
    btn.title = hasDlnaTarget()
        ? ("Cast to " + dlnaTargetLabel())
        : "Select a DLNA device first";
    const icon = document.createElement("span");
    icon.className = "dlna-icon";
    btn.appendChild(icon);
    btn.onclick = function(ev) {
        if (ev) ev.stopPropagation();
        castFile(file, meta || {});
    };
    return btn;
}

function loadDlnaSettingsPanel() {
    const list = document.getElementById("dlnaDeviceList");
    if (!list) return;
    refreshDlnaState().then(function(data) {
        renderDlnaDeviceList(list, data.devices || []);
        const baseInput = document.getElementById("dlnaPublicBase");
        if (baseInput && data.public_base) baseInput.value = data.public_base;
    }).catch(function(e) {
        if (list) {
            clearElement(list);
            list.appendChild(makeMeta("Error: " + (e.message || String(e))));
        }
    });
}

window.renderDlnaDeviceList = renderDlnaDeviceList;
window.scanDlnaDevices = scanDlnaDevices;
window.saveDlnaPublicBase = saveDlnaPublicBase;
window.clearDlnaTarget = clearDlnaTarget;
window.castFile = castFile;
window.castCurrentSong = castCurrentSong;
window.dlnaTransport = dlnaTransport;
window.makeCastButton = makeCastButton;
window.refreshDlnaState = refreshDlnaState;
window.loadDlnaSettingsPanel = loadDlnaSettingsPanel;
window.hasDlnaTarget = hasDlnaTarget;
window.onCastSelectChange = onCastSelectChange;
window.fillCastSelect = fillCastSelect;
