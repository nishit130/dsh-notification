# Changelog

## Unreleased

### Added
- Clicking a browser popup opens the Session that raised it
  (`ctx.uiWorkspace.openSession`), and every popup names that Session in its
  body. Popups now carry one tag per Session, so a second Session finishing no
  longer replaces an unread "waiting for you" popup.

### Fixed
- Desktop notifications no longer crash the dsh host process when the
  notifier binary is missing (e.g. headless Linux without `notify-send`).
  `spawn()` failures are delivered asynchronously as an `'error'` event on
  the returned ChildProcess, so the existing try/catch could not catch them
  and Node rethrew the event as `uncaughtException` on every turn end.
  Every platform branch now attaches a no-op `'error'` listener synchronously,
  keeping the notifier strictly best-effort. (closes #1)
- The browser channel never fired "Waiting for you": it read
  `pendingInteraction` off the `ctx.sessions.list` catalog row, which never
  carries one. It reads `ctx.uiSession.sessionStatus` — where pending
  interactions actually live — and subscribes to it, because an approval does
  not change the catalog.
- The browser channel stayed silent whenever the page read as visible, so a
  window behind another app never notified. `browserOnlyWhenHidden` now
  suppresses popups only while the window is visible **and** focused.

## 0.1.1 — 2026-08-21

### Added
- **Browser notification channel**: a web client half (`dsh.client`) that watches the
  session list and fires `Notification` popups on the machine viewing the Web UI —
  covering the remote-server topology where host desktop notifications fire out of sight.
  New config: `browser` (default `true`), `browserOnlyWhenHidden` (default `true`).
- Smoke-test suite (`npm test`) and CI on Node 20/22.

### Changed
- `@deepseek-ai/schemastery` moved from `dependencies` to `peerDependencies` — the
  runtime context supplies one shared copy.

## 0.1.0 — 2026-08-21

Initial release.

- Desktop notifications on the server host (macOS `osascript`, Linux `notify-send`,
  Windows PowerShell toast), zero dependencies.
- Optional webhook `POST` with a Slack-compatible `text` field.
- Events: turn finished (`agent/status`, gated by `minTurnDurationMs`), agent error
  (`agent/error`), approval pending (`approval/request`, observe-only).
- Effect-bound listeners: automatic cleanup on unload and hot reload.
