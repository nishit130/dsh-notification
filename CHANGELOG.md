# Changelog

## Unreleased

### Added
- Clicking a browser popup opens the Session that raised it
  (`ctx.uiWorkspace.openSession`), and every popup names that Session in its
  body. Popups now carry one tag per Session, so a second Session finishing no
  longer replaces an unread "waiting for you" popup.
- **Click a popup to get the window back.** `window.focus()` only focuses the
  frame, so inside the desktop shell a minimized window stayed minimized; the
  page now also POSTs `/plugins/dsh-notification/focus`, which restores and
  focuses the DSH window. The window is identified by the app (the executable
  the dsh host runs from), not by the toast `title`. Windows is measured
  (`focus-window.ps1`); macOS (`osascript` activate) and Linux (`wmctrl -a`)
  are best-effort. The route refuses cross-site calls (action header) and
  rejects clicks from another machine (nothing to raise there).
- New `desktopAppId` config: the AppUserModelId used for Windows toasts.
- Outcome log for both halves: `%TEMP%\dsh-notification\notify.log` (rotated to
  `.1` past 512 KiB), and a `windows-latest` CI job that parses the shipped
  PowerShell with Windows PowerShell 5.1.

### Fixed
- **The Windows channel never showed a toast.** `desktopNotify()` spawned the
  toast helper with `detached: true` and `stdio: 'ignore'`; a
  DETACHED_PROCESS console host turns WinRT
  `ToastNotificationManager.Show()` into a silent no-op — the helper exits 0,
  nothing appears, nothing is recorded. Measured on Windows 11 26100: the same
  toast is delivered once the child is no longer detached, regardless of the
  AppUserModelId. Windows toasts are now spawned non-detached with piped
  output; either way, toasts no longer use the **display title** as the
  AppUserModelId unless nothing better is available: `toast.ps1` takes the
  running desktop app's own identity from its Start Menu shortcut
  (`System.AppUserModel.ID`), accepts it only from an ancestor that runs the
  same executable as the dsh host (a terminal that launched `dsh web` is never
  adopted), and falls back to `title` otherwise. (closes #3)
- Toast and focus outcomes are no longer invisible: each attempt appends a JSON
  line to `%TEMP%\dsh-notification\notify.log` (`toast-shown` with the
  `appid` it used, or `toast-failed` with exit code and stderr; `focus-ok` /
  `focus-failed` for clicks), and the first failure warns once.
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
