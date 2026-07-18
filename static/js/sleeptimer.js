function formatSleepRemaining(seconds) {
    seconds = Math.max(0, Number(seconds) || 0);
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return m + ":" + String(s).padStart(2, "0");
}

function toggleSleepPopover() {
    const pop = document.getElementById("sleepPopover");
    if (!pop) return;
    pop.classList.toggle("hidden");
}

function updateSleepTimerUI(timer) {
    const label = document.getElementById("sleepTimerLabel");
    const tBtn = document.getElementById("sleepTimerBtn");
    timer = timer || {active: false};

    document.querySelectorAll("[data-sleep]").forEach(function(btn) {
        const key = btn.getAttribute("data-sleep");
        let on = false;
        if (!timer.active && key === "off") on = true;
        else if (timer.active && timer.mode === "minutes" && String(timer.minutes) === key) on = true;
        btn.classList.toggle("active", on);
    });

    if (tBtn) {
        tBtn.classList.toggle("timer-active", !!timer.active);
        if (timer.active && timer.mode === "minutes" && timer.remaining != null) {
            tBtn.title = "Sleep in " + formatSleepRemaining(timer.remaining);
        } else {
            tBtn.title = "Sleep timer";
        }
    }

    if (!label) return;
    if (!timer.active) {
        label.innerText = "Sleep off";
        return;
    }
    label.innerText = "Sleep in " + formatSleepRemaining(timer.remaining);
}

async function setSleepTimer(mode, minutes) {
    const payload = {mode: mode || "off"};
    if (mode === "minutes") payload.minutes = minutes || 30;
    try {
        const data = await api("/api/sleeptimer", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify(payload)
        });
        updateSleepTimerUI(data);
        if (typeof flashPlayerAction === "function") {
            if (!data.active) flashPlayerAction("Sleep timer off");
            else flashPlayerAction("Sleep in " + (minutes || 30) + " min");
        }
    } catch (e) {
        alert(e.message || String(e));
    }
}

window.setSleepTimer = setSleepTimer;
window.updateSleepTimerUI = updateSleepTimerUI;
window.toggleSleepPopover = toggleSleepPopover;
