import { spawn as nodeSpawn } from 'node:child_process'
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Schema from '@deepseek-ai/schemastery'

export const name = 'dsh-notification'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * `toast.ps1` sends the Windows toast; `focus-window.ps1` brings the desktop
 * window back. Both ship with the package (see `files` in package.json).
 */
const TOAST_SCRIPT = join(HERE, 'toast.ps1')
const FOCUS_SCRIPT = join(HERE, 'focus-window.ps1')

/**
 * Endpoint the browser half POSTs to when a popup is clicked. Lives under
 * `/plugins/` because that namespace is reserved for plugin-owned routes.
 */
export const FOCUS_ROUTE = '/plugins/dsh-notification/focus'
const FOCUS_ACTION_HEADER = 'x-dsh-notification-action'
const FOCUS_ACTION = 'focus'

/**
 * Every toast/focus outcome is appended here as one JSON line, so a Windows
 * reporter has something concrete to attach: the toast used to fail silently
 * (`stdio: 'ignore'` plus a detached console host), and nothing was recorded.
 */
const LOG_DIR = join(tmpdir(), 'dsh-notification')
const LOG_FILE = join(LOG_DIR, 'notify.log')
const LOG_MAX_BYTES = 512 * 1024

/**
 * The desktop app's own window title suffix, used only to identify the window
 * for click-to-focus. Deliberately NOT `config.title`: that one is toast text,
 * and a user who sets `title: 'Agent'` must still get their window back.
 */
const WINDOW_TITLE = 'DeepSeek Harness'

/**
 * The executable the dsh host itself runs from. On Windows the desktop app's
 * window belongs to an ancestor process running this same executable, which is
 * how the helpers tell the app apart from a terminal that merely launched
 * `dsh web` (a terminal has its own Start Menu identity; adopting it would
 * brand the toast as the terminal and focus it instead of DSH).
 */
const HOST_EXE = process.execPath

/**
 * The toast helper speaks WinRT through Windows PowerShell 5.1. Resolve the
 * full path instead of relying on `PATH`: the desktop app's host process does
 * not necessarily inherit the shell's `PATH`.
 */
const POWERSHELL = process.env.SystemRoot
  ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'powershell.exe'

const HELPER_TIMEOUT_MS = 15_000

export const Config = Schema.object({
  notifyOnIdle: Schema.boolean().default(true)
    .description('Notify when an agent finishes a turn (status flips to idle).'),
  notifyOnError: Schema.boolean().default(true)
    .description('Notify when a step or turn errors (agent/error).'),
  notifyOnApproval: Schema.boolean().default(true)
    .description('Notify when a tool call is waiting for user approval.'),
  minTurnDurationMs: Schema.number().default(5000)
    .description('Only notify for turns that ran at least this long, to skip quick replies.'),
  desktop: Schema.boolean().default(true)
    .description('Show a native desktop notification on the machine running the dsh server (macOS/Linux/Windows).'),
  browser: Schema.boolean().default(true)
    .description('Show browser Notification popups in the Web UI — fires on the machine viewing the page, so it works with a remote server.'),
  browserOnlyWhenHidden: Schema.boolean().default(true)
    .description('Only show browser notifications while the tab is hidden; a visible tab already has your attention.'),
  webhookUrl: Schema.string().default('')
    .description('Optional URL to POST a JSON payload to (Slack-compatible "text" field included).'),
  title: Schema.string().default('DeepSeek Harness')
    .description('Title used for desktop notifications.'),
  desktopAppId: Schema.string().default('')
    .description('Windows AppUserModelId for desktop toasts; empty = the running desktop app\'s own identity, then `title`.'),
})

/** Append one JSON line to %TEMP%\dsh-notification\notify.log, rotated once. */
function recordOutcome(entry) {
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    try {
      if (statSync(LOG_FILE).size > LOG_MAX_BYTES) renameSync(LOG_FILE, `${LOG_FILE}.1`)
    } catch {
      // No log yet: nothing to rotate.
    }
    appendFileSync(LOG_FILE, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`)
  } catch {
    // Diagnostics are best-effort: they must never break a notification.
  }
}

let warned = false
function warnUnavailable(message) {
  if (warned) return
  warned = true
  try {
    console.warn(`[dsh-notification] ${message}; see ${LOG_FILE}`)
  } catch {}
}

/**
 * Watch a one-shot helper process: collect its output, reap it, and report the
 * single outcome. `stdio: 'ignore'` cannot report anything — which is why the
 * Windows channel used to fail invisibly.
 */
function observe(child, done) {
  let stdout = ''
  let stderr = ''
  let settled = false
  const finish = (outcome) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    done({
      code: outcome.code ?? null,
      signal: outcome.signal ?? null,
      error: outcome.error ? String(outcome.error?.message ?? outcome.error) : undefined,
      stdout: stdout.trim().slice(0, 400),
      stderr: stderr.trim().slice(0, 400),
    })
  }
  const timer = setTimeout(() => {
    try { child.kill() } catch {}
  }, HELPER_TIMEOUT_MS)
  timer.unref?.()
  child.stdout?.on('data', (chunk) => { stdout += chunk })
  child.stderr?.on('data', (chunk) => { stderr += chunk })
  child.on('error', (error) => finish({ error }))
  child.on('exit', (code, signal) => finish({ code, signal }))
}

/**
 * Windows toast: shipped as a script rather than an inline `-Command` so the
 * title and body travel as real process arguments (no quoting or code-page
 * games) and so `Show()`'s outcome can be verified.
 *
 * Two measured rules live here:
 *  - **No `detached: true`.** A DETACHED_PROCESS console host turns WinRT
 *    `ToastNotificationManager.Show()` into a silent no-op on Windows 11
 *    26100: the process exits 0, no toast appears, and the notification store
 *    records nothing. This — not the AppUserModelId — is why the Windows
 *    channel never showed a toast (issue #3).
 *  - **Pipe stdout/stderr.** `toast.ps1` prints `toast shown appid=…` only
 *    after `Show()` returned, so failures become a log line instead of a
 *    mystery.
 */
function windowsNotify(title, body, { spawn, appId, record }) {
  const args = [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', TOAST_SCRIPT,
    '-Title', String(title), '-Body', String(body),
    '-HostExe', HOST_EXE,
  ]
  if (appId) args.push('-AppId', appId)

  let child
  try {
    child = spawn(POWERSHELL, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      windowsHide: true,
    })
  } catch (error) {
    record({ event: 'desktop-spawn-failed', error: String(error?.message ?? error) })
    warnUnavailable('the Windows toast helper could not be started')
    return
  }
  observe(child, (outcome) => {
    const shown = outcome.code === 0 && /toast shown/.test(outcome.stdout)
    // The helper prints the identity it used; keep it as a field so a report
    // does not have to dig through stdout.
    const resolved = /toast shown appid=(.*)$/m.exec(outcome.stdout)
    record({ event: shown ? 'toast-shown' : 'toast-failed', title: String(title).slice(0, 80), appid: resolved?.[1], ...outcome })
    if (!shown) warnUnavailable('the Windows toast was not shown')
  })
}

/**
 * Fire a native desktop notification without any dependency:
 * osascript on macOS, notify-send on Linux, a PowerShell toast on Windows.
 *
 * Failures are swallowed — a notifier must never break the agent loop.
 * spawn() failures (missing binary, EACCES, …) are delivered ASYNCHRONOUSLY
 * as an `'error'` event on the returned ChildProcess, so a try/catch around
 * the synchronous spawn() call cannot catch them. Without an `'error'`
 * listener, Node rethrows the event and kills the whole dsh process — which
 * is exactly what happens on headless Linux with no `notify-send` installed.
 * Every platform branch attaches an `'error'` listener synchronously, so a
 * missing or failing notifier binary can never take the host down; the
 * Windows branch additionally records the outcome (see `observe`).
 *
 * `deps.spawn` is injectable so the regression test can simulate an async
 * ENOENT without mutating `node:child_process` (a frozen built-in namespace).
 * `deps.platform` and `deps.record` are injectable for the same reason.
 */
export function desktopNotify(title, body, { spawn = nodeSpawn, platform = process.platform, appId = '', record = recordOutcome } = {}) {
  try {
    if (platform === 'darwin') {
      const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
      spawn('osascript', ['-e', `display notification "${esc(body)}" with title "${esc(title)}"`],
        { stdio: 'ignore', detached: true }).on('error', () => {}).unref()
    } else if (platform === 'linux') {
      spawn('notify-send', [title, body], { stdio: 'ignore', detached: true }).on('error', () => {}).unref()
    } else if (platform === 'win32') {
      windowsNotify(title, body, { spawn, appId, record })
    }
  } catch {}
}

/**
 * Bring the DSH window back to the foreground after a notification click.
 *
 * `window.focus()` in the page only focuses the frame: inside the Electron
 * shell a minimized or hidden window stays where it is, so the click looks
 * like a no-op (issue #3). The host half therefore runs a platform helper:
 *  - Windows: `focus-window.ps1` (restore + force foreground). The window is
 *    identified by the executable the dsh host runs from, never by the toast
 *    title — `title` is display text, and a terminal that launched `dsh web`
 *    must not be raised instead;
 *  - macOS: `osascript` activate the `DeepSeek Harness` app;
 *  - Linux: `wmctrl -a 'DeepSeek Harness'`.
 *
 * Measured on Windows 11 26100: spawned with `detached: true` the same helper
 * exits 0 and leaves the window minimized, so it is spawned non-detached too.
 * macOS/Linux helpers are best-effort — they are not tested on real hardware.
 */
export function focusWindow({ spawn = nodeSpawn, platform = process.platform, windowTitle = WINDOW_TITLE, hostExe = HOST_EXE, record = recordOutcome } = {}) {
  let spec
  if (platform === 'win32') {
    spec = {
      command: POWERSHELL,
      args: [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', FOCUS_SCRIPT,
        '-WindowTitle', String(windowTitle), '-HostExe', String(hostExe),
      ],
      options: { detached: false, windowsHide: true },
    }
  } else if (platform === 'darwin') {
    const escaped = String(windowTitle).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    spec = { command: 'osascript', args: ['-e', `tell application "${escaped}" to activate`], options: {} }
  } else if (platform === 'linux') {
    spec = { command: 'wmctrl', args: ['-a', String(windowTitle)], options: {} }
  } else {
    return
  }

  let child
  try {
    child = spawn(spec.command, spec.args, { stdio: ['ignore', 'pipe', 'pipe'], ...spec.options })
  } catch (error) {
    record({ event: 'focus-spawn-failed', platform, error: String(error?.message ?? error) })
    return
  }
  observe(child, (outcome) => {
    record({ event: /focus ok/.test(outcome.stdout) ? 'focus-ok' : 'focus-failed', platform, ...outcome })
  })
}

/** Only a window on this machine can be focused; a remote viewer has none. */
function isLoopback(req) {
  const address = req?.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * Handler for {@link FOCUS_ROUTE}: one POST from the page's popup click.
 *
 * The action header is the whole guard: a cross-site page can set it only
 * after a CORS preflight this route never answers, while the Web UI fetches
 * from its own origin. The action itself is harmless — raise a local window.
 */
export function createFocusHandler({ spawn = nodeSpawn, platform = process.platform, windowTitle = WINDOW_TITLE, hostExe = HOST_EXE, record = recordOutcome } = {}) {
  return function focusHandler(req, res) {
    const reply = (status, payload, headers = {}) => {
      try {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers })
        res.end(JSON.stringify(payload))
      } catch {
        // The page may be gone already; nothing left to answer.
      }
    }
    if (req.method !== 'POST') return reply(405, { ok: false, error: 'POST only' }, { allow: 'POST' })
    // The click carries no payload; drain whatever a client sent so the
    // socket is not left half-read.
    req.resume?.()
    if (req.headers?.[FOCUS_ACTION_HEADER] !== FOCUS_ACTION) return reply(403, { ok: false, error: 'missing action header' })
    if (!isLoopback(req)) return reply(403, { ok: false, error: 'the click came from another machine' })
    focusWindow({ spawn, platform, windowTitle, hostExe, record })
    return reply(202, { ok: true })
  }
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${s % 60}s`
}

export function apply(ctx, config) {
  // Turn timing, keyed by the live agent object; cleaned on agent/disposed.
  const startedAt = new Map()

  function notify(summary, body, level) {
    const text = body ? `${summary} — ${body}` : summary
    if (config.desktop) desktopNotify(config.title, text, { appId: config.desktopAppId })
    if (config.webhookUrl) {
      fetch(config.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, summary, body, level, ts: new Date().toISOString() }),
      }).catch(() => {}) // never let a webhook failure surface into the agent loop
    }
  }

  // Turn finished: agent/status flips running -> idle (emit mode).
  ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'running') {
      startedAt.set(agent, Date.now())
      return
    }
    const t0 = startedAt.get(agent)
    startedAt.delete(agent)
    if (!config.notifyOnIdle || t0 == null) return
    const elapsed = Date.now() - t0
    if (elapsed < config.minTurnDurationMs) return
    notify('Agent finished', `done in ${formatDuration(elapsed)}`, 'info')
  })

  // A step or turn errored (emit mode).
  ctx.on('agent/error', ({ error, turn, step }) => {
    if (!config.notifyOnError) return
    const detail = String(error?.message ?? error ?? 'unknown error').slice(0, 200)
    notify('Agent error', `turn ${turn}, step ${step}: ${detail}`, 'error')
  })

  // A tool call awaits approval. approval/request is a WATERFALL: this
  // listener only observes, so it must delegate with next() — returning
  // without it would claim the decision and swallow real answerers.
  ctx.on('approval/request', (req, next) => {
    if (config.notifyOnApproval) {
      const detail = req.reason ? `${req.toolName} — ${req.reason}` : req.toolName
      notify('Approval needed', detail, 'warn')
    }
    return next()
  })

  // Drop timing state for agents that leave the registry.
  ctx.on('agent/disposed', ({ agent }) => {
    startedAt.delete(agent)
  })

  // Click-to-focus: the browser half POSTs here when a popup is clicked.
  // `ctx.inject` defers until the web server exists, so the plugin stays
  // loadable in profiles that have none (headless).
  ctx.inject(['webServer'], (webCtx) => {
    const handler = createFocusHandler()
    webCtx.effect(
      () => webCtx.get('webServer').register({ kind: 'exact', path: FOCUS_ROUTE, handler }),
      'dsh-notification: focus route',
    )
  })

  // All listeners above are effects on ctx: they are removed automatically
  // when this plugin unloads or hot-reloads. No manual cleanup needed.
}
