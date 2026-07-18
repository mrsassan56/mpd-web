/** Global keyboard shortcuts (desktop + mobile). */

function isTypingTarget(el) {
    if (!el) return false;
    const tag = (el.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return true;
    if (el.isContentEditable) return true;
    return !!el.closest("input, textarea, select, [contenteditable='true']");
}

function initKeyboardShortcuts() {
    document.addEventListener("keydown", function(e) {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        if (isTypingTarget(e.target)) return;

        if (e.code === "Space" || e.key === " ") {
            e.preventDefault();
            if (typeof togglePlayPause === "function") togglePlayPause();
            return;
        }
        if (e.key === "ArrowLeft") {
            e.preventDefault();
            if (typeof cmd === "function") cmd("previous");
            return;
        }
        if (e.key === "ArrowRight") {
            e.preventDefault();
            if (typeof cmd === "function") cmd("next");
            return;
        }
    });
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initKeyboardShortcuts);
} else {
    initKeyboardShortcuts();
}
