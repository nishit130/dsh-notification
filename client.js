/* dsh-notification — client bundle (hand-written, matches the official
 * tsdown output shape, so no build step is needed).
 *
 * Browser-side half of dsh-notification: watches the client session list
 * (ctx.sessions.list from @deepseek-ai/dsh-client-runtime) and fires browser
 * Notification popups on the machine VIEWING the Web UI — which is what you
 * want when the dsh server runs on a remote box and the host-side desktop
 * notifications would fire where nobody sees them.
 *
 *   - a session finishes (running true→false with nothing pending)  → "Agent finished"
 *   - a session starts waiting on you (pendingInteraction appears)  → "Waiting for you"
 *
 * A popup names the Session that raised it, and clicking it opens that
 * Session: ctx.uiWorkspace.openSession() switches the main view back to the
 * Conversation and persists the choice. Pending interactions are read from
 * ctx.uiSession.sessionStatus, which is where they live — a catalog row in
 * ctx.sessions.list never carries `pendingInteraction`.
 *
 * Clicking also asks the host to raise the window. window.focus() alone only
 * focuses the frame: inside the DSH Electron shell a minimized or hidden
 * window stays where it is, so the click used to look like a no-op. The host
 * half exposes POST /plugins/dsh-notification/focus, which restores the
 * desktop window (Win32 on Windows, osascript on macOS, wmctrl on Linux).
 *
 * Permission is requested on the first user gesture (browsers reject
 * programmatic prompts without one). By default popups show only while the
 * window is hidden or unfocused — a window you are looking at already has
 * your attention.
 */
window.__ModuleLoader__.load({
  id: "dsh-notification",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    var inject = ["sessions"];

    // Host route that restores + focuses the DSH window (see index.js).
    var FOCUS_ROUTE = "/plugins/dsh-notification/focus";

    // Ask the host to raise the window. Fire-and-forget: the popup closes
    // right after, and a host without the route (older version, remote server,
    // headless) simply answers nothing.
    function focusWindowInHost() {
      if (typeof fetch !== "function") return;
      try {
        fetch(FOCUS_ROUTE, {
          method: "POST",
          headers: { "x-dsh-notification-action": "focus" },
          body: "{}",
          keepalive: true,
        }).catch(function () {});
      } catch (e) {}
    }

    function canNotify() {
      return typeof Notification !== "undefined";
    }

    function ensurePermission() {
      // Prompt once, on the first gesture; never block on the result.
      if (!canNotify() || Notification.permission !== "default") return;
      function ask() {
        window.removeEventListener("pointerdown", ask, true);
        window.removeEventListener("keydown", ask, true);
        try { Notification.requestPermission().catch(function () {}); } catch (e) {}
      }
      window.addEventListener("pointerdown", ask, true);
      window.addEventListener("keydown", ask, true);
    }

    function formatDuration(ms) {
      if (ms < 1000) return ms + "ms";
      var s = Math.round(ms / 1000);
      if (s < 60) return s + "s";
      return Math.floor(s / 60) + "m " + (s % 60) + "s";
    }

    function apply(ctx, config) {
      var cfg = config || {};
      if (cfg.browser === false) return;
      var title = typeof cfg.title === "string" && cfg.title ? cfg.title : "DeepSeek Harness";
      var notifyOnIdle = cfg.notifyOnIdle !== false;
      var notifyOnApproval = cfg.notifyOnApproval !== false;
      var onlyWhenHidden = cfg.browserOnlyWhenHidden !== false;
      var minTurnMs = typeof cfg.minTurnDurationMs === "number" ? cfg.minTurnDurationMs : 5000;

      if (!canNotify()) return;
      ensurePermission();

      // Open the Session behind a popup. uiWorkspace.openSession switches the
      // main view and selects the Conversation panel, so the click lands on the
      // exact conversation that raised the notification; it persists the choice
      // as dsh.sessions.current, so a reload returns to the same Session.
      function openSession(sessionId) {
        if (!sessionId) return;
        var workspace = ctx.get("uiWorkspace");
        try {
          if (workspace && typeof workspace.openSession === "function") workspace.openSession(sessionId);
        } catch (e) {}
      }

      // "It has your attention" means visible AND focused. An unfocused window
      // — another app in front, minimized, or on another Space — does not, and
      // that is exactly when the click-through matters.
      function userIsLooking() {
        return document.visibilityState === "visible" && typeof document.hasFocus === "function" && document.hasFocus();
      }

      function show(body, sessionId, label) {
        if (Notification.permission !== "granted") return;
        if (onlyWhenHidden && userIsLooking()) return;
        try {
          var n = new Notification(title, {
            body: label ? label + " — " + body : body,
            // One tag per Session: finishing in Session B must not replace the
            // unread "needs you" popup of Session A.
            tag: sessionId ? "dsh-notification:" + sessionId : "dsh-notification",
          });
          n.onclick = function () {
            try { window.focus(); } catch (e) {}
            focusWindowInHost();
            openSession(sessionId);
            n.close();
          };
        } catch (e) {}
      }

      var sessions = ctx.get("sessions");
      if (!sessions || !sessions.list) return;
      var list = sessions.list;

      // Pending interactions are a ui-session fact, not a catalog one:
      // sessionStatus maps id → { running, pendingInteraction, completionUnread }.
      var uiSession = ctx.get("uiSession");
      var status = uiSession && uiSession.sessionStatus ? uiSession.sessionStatus : null;

      function pendingOf(id) {
        if (!status) return undefined;
        var row = status.getSnapshot().get(id);
        return row ? row.pendingInteraction : undefined;
      }

      function labelOf(row) {
        var display = row && row.displayTitle;
        // An untitled Session displays its raw id; that is noise in a popup.
        return typeof display === "string" && display && display !== row.id ? display : "";
      }

      // sessionId -> { pending, running, runningSince, label }
      var prev = new Map();
      function snapshotRow(row) {
        return { pending: pendingOf(row.id), running: !!row.running, runningSince: 0, label: labelOf(row) };
      }
      function seed() {
        prev.clear();
        var snap = list.getSnapshot();
        var ids = snap.ids || [];
        for (var i = 0; i < ids.length; i++) {
          var row = snap.byId[ids[i]];
          if (row) prev.set(ids[i], snapshotRow(row));
        }
      }

      function scan() {
        var snap = list.getSnapshot();
        var ids = snap.ids || [];
        for (var i = 0; i < ids.length; i++) {
          var id = ids[i];
          var row = snap.byId[id];
          if (!row) continue;
          if (row.origin === "subagent") continue;
          var p = prev.get(id);
          if (!p) {
            prev.set(id, snapshotRow(row));
            continue;
          }
          // Track when a run started so short turns stay quiet, mirroring
          // the host side's minTurnDurationMs gate.
          if (!p.running && row.running) p.runningSince = Date.now();
          var pending = pendingOf(id);
          // Waiting on the user: pendingInteraction appeared.
          if (notifyOnApproval && p.pending === undefined && pending !== undefined) {
            var kind = typeof pending === "string" ? pending : "input";
            show("Waiting for you — " + kind, id, p.label);
          }
          // Turn finished: running flipped off with nothing pending.
          if (notifyOnIdle && p.running && !row.running && pending === undefined) {
            var elapsed = p.runningSince ? Date.now() - p.runningSince : null;
            if (elapsed === null || elapsed >= minTurnMs) {
              show(elapsed === null ? "Agent finished" : "Agent finished — " + formatDuration(elapsed), id, p.label);
            }
          }
          p.pending = pending;
          p.running = !!row.running;
          p.label = labelOf(row) || p.label;
          prev.set(id, p);
        }
      }

      seed();

      var unsubList = list.subscribe(scan);
      // Approvals land on the status map, which the catalog list does not
      // broadcast, so watch it as well.
      var unsubStatus = status && status.subscribe ? status.subscribe(scan) : null;

      ctx.effect(function () {
        return function () {
          unsubList();
          if (unsubStatus) unsubStatus();
        };
      }, "dsh-notification: session watch");
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
