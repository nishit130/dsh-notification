import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  apply, Config, createFocusHandler, desktopNotify, FOCUS_ROUTE, focusWindow, name,
} from '../index.js'

/**
 * Minimal Cordis-shaped context: records listeners, exposes emit helpers.
 *
 * `get`/`inject`/`effect` mirror the parts of Cordis the plugin uses:
 * `inject(names, callback)` starts the callback only when every named service
 * is present, exactly like the real fiber.
 */
function mockCtx({ services = {} } = {}) {
  const listeners = new Map()
  const effects = []
  const ctx = {
    listeners,
    effects,
    get: (serviceName) => services[serviceName],
    inject(names, callback) {
      if (names.every((serviceName) => services[serviceName] !== undefined)) callback(ctx)
      return ctx
    },
    effect(register, label) {
      const dispose = register()
      effects.push({ label, dispose })
      return dispose
    },
    on(event, fn) {
      listeners.set(event, fn)
    },
    emit(event, ...args) {
      return listeners.get(event)?.(...args)
    },
  }
  return ctx
}

/** ChildProcess stand-in with the streams `observe()` reads. */
function fakeChild({ stdout = '', stderr = '', code = 0 } = {}) {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = () => {}
  setImmediate(() => {
    if (stdout) child.stdout.emit('data', stdout)
    if (stderr) child.stderr.emit('data', stderr)
    child.emit('exit', code)
  })
  return child
}

/** A web server stub capturing registered routes. */
function fakeWebServer() {
  const routes = []
  return {
    routes,
    register(route) {
      routes.push(route)
      return () => {}
    },
  }
}

/** Minimal http request for the focus handler. */
function fakeRequest({ method = 'POST', headers = { 'x-dsh-notification-action': 'focus' }, remoteAddress = '127.0.0.1' } = {}) {
  return { method, headers, socket: { remoteAddress } }
}

/** Minimal http response capturing the status and body. */
function fakeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers) { this.statusCode = status; this.headers = headers ?? {}; return this },
    end(body = '') { this.body = body ?? '' },
  }
}

/** Stub global fetch, capturing webhook payloads. Returns captured calls. */
function captureWebhook(t) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = (url, init) => {
    calls.push({ url, payload: JSON.parse(init.body) })
    return Promise.resolve({ ok: true })
  }
  t.after(() => { globalThis.fetch = original })
  return calls
}

/** Config with both silent channels off and the webhook as the observable. */
function webhookConfig(overrides = {}) {
  return new Config({
    desktop: false,
    webhookUrl: 'https://example.invalid/hook',
    minTurnDurationMs: 0,
    ...overrides,
  })
}

test('exports a named plugin with a validating schema', () => {
  assert.equal(name, 'dsh-notification')
  const config = new Config({})
  assert.equal(config.notifyOnIdle, true)
  assert.equal(config.minTurnDurationMs, 5000)
  assert.equal(config.browser, true)
})

test('apply registers the four listeners', () => {
  const ctx = mockCtx()
  apply(ctx, webhookConfig())
  assert.deepEqual(
    [...ctx.listeners.keys()].sort(),
    ['agent/disposed', 'agent/error', 'agent/status', 'approval/request'],
  )
})

test('turn finish posts the webhook once the duration gate passes', (t) => {
  const calls = captureWebhook(t)
  const ctx = mockCtx()
  apply(ctx, webhookConfig())
  const agent = {}
  ctx.emit('agent/status', { agent, status: 'running' })
  ctx.emit('agent/status', { agent, status: 'idle' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].payload.summary, 'Agent finished')
  assert.equal(calls[0].payload.level, 'info')
  assert.match(calls[0].payload.text, /^Agent finished/)
})

test('a turn below minTurnDurationMs stays quiet', (t) => {
  const calls = captureWebhook(t)
  const ctx = mockCtx()
  apply(ctx, webhookConfig({ minTurnDurationMs: 60_000 }))
  const agent = {}
  ctx.emit('agent/status', { agent, status: 'running' })
  ctx.emit('agent/status', { agent, status: 'idle' })
  assert.equal(calls.length, 0)
})

test('idle without a tracked start never notifies', (t) => {
  const calls = captureWebhook(t)
  const ctx = mockCtx()
  apply(ctx, webhookConfig())
  ctx.emit('agent/status', { agent: {}, status: 'idle' })
  assert.equal(calls.length, 0)
})

test('agent/error posts an error-level webhook with turn and step', (t) => {
  const calls = captureWebhook(t)
  const ctx = mockCtx()
  apply(ctx, webhookConfig())
  ctx.emit('agent/error', { agent: {}, turn: 3, step: 2, error: new Error('boom') })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].payload.level, 'error')
  assert.match(calls[0].payload.body, /turn 3, step 2: boom/)
})

test('approval/request notifies AND always delegates to next()', async (t) => {
  const calls = captureWebhook(t)
  const ctx = mockCtx()
  apply(ctx, webhookConfig())
  let delegated = false
  const outcome = await ctx.emit('approval/request',
    { toolName: 'bash', reason: 'rm -rf build' },
    () => { delegated = true; return Promise.resolve('allowed-once') })
  assert.equal(delegated, true, 'observe-only waterfall listener must call next()')
  assert.equal(outcome, 'allowed-once', 'must return the downstream outcome unchanged')
  assert.equal(calls[0].payload.summary, 'Approval needed')
  assert.match(calls[0].payload.body, /bash — rm -rf build/)
})

test('approval/request delegates even with notifications off', async (t) => {
  const calls = captureWebhook(t)
  const ctx = mockCtx()
  apply(ctx, webhookConfig({ notifyOnApproval: false }))
  let delegated = false
  await ctx.emit('approval/request', { toolName: 'bash' },
    () => { delegated = true; return Promise.resolve('rejected') })
  assert.equal(delegated, true)
  assert.equal(calls.length, 0)
})

test('per-event toggles silence their channel', (t) => {
  const calls = captureWebhook(t)
  const ctx = mockCtx()
  apply(ctx, webhookConfig({ notifyOnIdle: false, notifyOnError: false }))
  const agent = {}
  ctx.emit('agent/status', { agent, status: 'running' })
  ctx.emit('agent/status', { agent, status: 'idle' })
  ctx.emit('agent/error', { agent, turn: 1, step: 1, error: 'x' })
  assert.equal(calls.length, 0)
})

test('agent/disposed drops turn-timing state', (t) => {
  const calls = captureWebhook(t)
  const ctx = mockCtx()
  apply(ctx, webhookConfig())
  const agent = {}
  ctx.emit('agent/status', { agent, status: 'running' })
  ctx.emit('agent/disposed', { agent })
  ctx.emit('agent/status', { agent, status: 'idle' })
  assert.equal(calls.length, 0, 'no notification for an agent disposed mid-turn')
})

/**
 * Regression test for issue #1: on headless Linux without `notify-send`,
 * `spawn()` returns synchronously and the OS failure (ENOENT) arrives later
 * as an `'error'` event on the ChildProcess. A missing `'error'` listener
 * makes Node rethrow it as uncaughtException and kill the whole dsh process.
 * The fix attaches a no-op `'error'` listener synchronously on every branch
 * so the async error is swallowed and the notifier stays best-effort.
 *
 * `node:child_process` is a frozen built-in module namespace in ESM, so we
 * inject the spawn function through `desktopNotify`'s `deps` parameter
 * instead of mutating the global — removing that parameter would silently
 * un-guard the headless-Linux crash path this test exists to cover.
 */
test('desktop notification swallows an async spawn ENOENT (regression for issue #1)', async (t) => {
  const fakeChild = new EventEmitter()
  fakeChild.unref = () => {}
  const enoent = Object.assign(new Error('spawn notify-send ENOENT'), { code: 'ENOENT' })
  setImmediate(() => fakeChild.emit('error', enoent))

  const spawnCalls = []
  const mockSpawn = (cmd, args, opts) => {
    spawnCalls.push({ cmd, args, opts })
    return fakeChild
  }

  const unhandled = []
  const onUncaught = (err) => { unhandled.push(err) }
  process.on('uncaughtException', onUncaught)
  t.after(() => { process.off('uncaughtException', onUncaught) })

  desktopNotify('DeepSeek Harness', 'Agent finished — done in 1m 31s', { spawn: mockSpawn, platform: 'linux' })

  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))

  assert.equal(spawnCalls.length, 1, 'exactly one spawn per desktop notification')
  assert.deepEqual(spawnCalls[0].opts, { stdio: 'ignore', detached: true })
  assert.equal(unhandled.length, 0,
    `spawn 'error' must NOT bubble to uncaughtException (got: ${unhandled.map((e) => e.message).join(', ')})`)
})

/**
 * Regression tests for issue #3: the Windows toast was spawned with
 * `detached: true` and `stdio: 'ignore'`. A DETACHED_PROCESS console host turns
 * WinRT `ToastNotificationManager.Show()` into a silent no-op — measured on
 * Windows 11 26100: the child exits 0, no toast appears, and the notification
 * store records nothing. Piping the output is what makes the failure visible.
 */
test('windows toast is not detached and its output is captured (regression for issue #3)', async () => {
  const records = []
  const spawnCalls = []
  const mockSpawn = (command, args, opts) => {
    spawnCalls.push({ command, args, opts })
    return fakeChild({ stdout: 'toast shown appid=electron.app.DeepSeek Harness\r\n' })
  }

  desktopNotify('DeepSeek Harness', 'Agent finished — done in 1m 31s', {
    spawn: mockSpawn,
    platform: 'win32',
    appId: '',
    record: (entry) => records.push(entry),
  })
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))

  assert.equal(spawnCalls.length, 1)
  const { command, args, opts } = spawnCalls[0]
  assert.match(command, /powershell\.exe$/i)
  assert.equal(args.includes('-File'), true, 'the toast ships as a script, not inline -Command')
  assert.match(args[args.indexOf('-File') + 1], /toast\.ps1$/)
  assert.equal(opts.detached, false, 'detached turns Show() into a silent no-op')
  assert.equal(opts.windowsHide, true)
  assert.deepEqual(opts.stdio, ['ignore', 'pipe', 'pipe'])
  assert.equal(args[args.indexOf('-HostExe') + 1], process.execPath,
    'the helper identifies the desktop app by the executable the host runs from')
  assert.equal(records.at(-1).event, 'toast-shown')
  assert.equal(records.at(-1).appid, 'electron.app.DeepSeek Harness',
    'the appid the helper used is a log field, not just stdout text')
})

test('a windows toast without a configured AppUserModelId leaves the identity to the helper', async () => {
  const spawnCalls = []
  desktopNotify('DeepSeek Harness', 'body', {
    spawn: (command, args, opts) => { spawnCalls.push({ args, opts }); return fakeChild({ stdout: 'toast shown' }) },
    platform: 'win32',
    appId: '',
    record: () => {},
  })
  await new Promise((r) => setImmediate(r))
  assert.equal(spawnCalls[0].args.includes('-AppId'), false,
    'no -AppId: the helper resolves the desktop app identity itself')
})

test('a windows AppUserModelId override is passed to the helper', async () => {
  const spawnCalls = []
  desktopNotify('DeepSeek Harness', 'body', {
    spawn: (command, args, opts) => { spawnCalls.push({ args, opts }); return fakeChild({ stdout: 'toast shown' }) },
    platform: 'win32',
    appId: 'electron.app.DeepSeek Harness',
    record: () => {},
  })
  await new Promise((r) => setImmediate(r))
  const args = spawnCalls[0].args
  assert.equal(args[args.indexOf('-AppId') + 1], 'electron.app.DeepSeek Harness')
})

test('a silent windows toast failure is recorded instead of vanishing', async () => {
  const records = []
  const unhandled = []
  const onUncaught = (err) => { unhandled.push(err) }
  process.on('uncaughtException', onUncaught)

  desktopNotify('DeepSeek Harness', 'body', {
    spawn: () => fakeChild({ code: 0, stderr: 'toast failed: no WinRT' }),
    platform: 'win32',
    record: (entry) => records.push(entry),
  })
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))
  process.off('uncaughtException', onUncaught)

  assert.equal(records.at(-1).event, 'toast-failed')
  assert.match(records.at(-1).stderr, /no WinRT/)
  assert.equal(unhandled.length, 0, 'a failed toast must never surface into the agent loop')
})

test('focusWindow spawns the platform helper with the window identity, never the toast title', () => {
  const cases = [
    { platform: 'win32', command: /powershell\.exe$/i, arg: /focus-window\.ps1$/, detached: false },
    { platform: 'darwin', command: /^osascript$/, arg: /activate/, detached: undefined },
    { platform: 'linux', command: /^wmctrl$/, arg: /DeepSeek Harness/, detached: undefined },
  ]
  for (const { platform, command, arg, detached } of cases) {
    const spawnCalls = []
    focusWindow({
      platform,
      // A display title must not become the window identity (issue #3 review):
      // the DSH app stays 'DeepSeek Harness' whatever the toast says.
      windowTitle: 'DeepSeek Harness',
      spawn: (cmd, args, opts) => { spawnCalls.push({ cmd, args, opts }); return fakeChild() },
      record: () => {},
    })
    assert.match(spawnCalls[0].cmd, command, `${platform} helper command`)
    assert.equal(spawnCalls[0].args.some((value) => arg.test(value)), true, `${platform} helper argument`)
    assert.equal(spawnCalls[0].opts.detached, detached, `${platform}: a detached helper cannot act on the UI`)
    if (platform === 'win32') {
      assert.equal(spawnCalls[0].args[spawnCalls[0].args.indexOf('-WindowTitle') + 1], 'DeepSeek Harness')
      assert.equal(spawnCalls[0].args[spawnCalls[0].args.indexOf('-HostExe') + 1], process.execPath)
    }
  }
})

test('focusWindow swallows a missing helper binary', () => {
  const unhandled = []
  const onUncaught = (err) => { unhandled.push(err) }
  process.on('uncaughtException', onUncaught)
  assert.doesNotThrow(() => {
    focusWindow({
      platform: 'linux',
      spawn: () => { throw new Error('spawn wmctrl ENOENT') },
      record: () => {},
    })
  })
  process.off('uncaughtException', onUncaught)
  assert.equal(unhandled.length, 0)
})

test('the focus handler rejects anything but the page action', () => {
  const spawnCalls = []
  const handler = createFocusHandler({
    platform: 'win32',
    spawn: (cmd, args, opts) => { spawnCalls.push({ cmd, args, opts }); return fakeChild() },
    record: () => {},
  })

  const wrongMethod = fakeResponse()
  handler(fakeRequest({ method: 'GET' }), wrongMethod)
  assert.equal(wrongMethod.statusCode, 405)
  assert.equal(wrongMethod.headers.allow, 'POST')

  const noHeader = fakeResponse()
  handler(fakeRequest({ headers: {} }), noHeader)
  assert.equal(noHeader.statusCode, 403)

  const remote = fakeResponse()
  handler(fakeRequest({ remoteAddress: '192.168.1.9' }), remote)
  assert.equal(remote.statusCode, 403)
  assert.match(JSON.parse(remote.body).error, /another machine/, 'a remote viewer has no window here to focus')

  assert.equal(spawnCalls.length, 0, 'no rejected request may touch the desktop')
})

test('a same-origin popup click focuses the window and is accepted', async () => {
  const spawnCalls = []
  const handler = createFocusHandler({
    platform: 'win32',
    spawn: (cmd, args, opts) => { spawnCalls.push({ cmd, args, opts }); return fakeChild({ stdout: 'focus ok hwnd=1 pid=2 attempts=1' }) },
    record: () => {},
  })
  const res = fakeResponse()
  handler(fakeRequest(), res)
  await new Promise((r) => setImmediate(r))

  assert.equal(res.statusCode, 202)
  assert.equal(JSON.parse(res.body).ok, true)
  assert.equal(spawnCalls.length, 1)
  assert.match(spawnCalls[0].cmd, /powershell\.exe$/i)
  assert.match(spawnCalls[0].args[spawnCalls[0].args.indexOf('-File') + 1], /focus-window\.ps1$/)
  assert.equal(spawnCalls[0].args[spawnCalls[0].args.indexOf('-WindowTitle') + 1], 'DeepSeek Harness',
    'the handler is not given the toast title: the window identity is the app')
})

test('apply registers the focus route once the web server exists', () => {
  const webServer = fakeWebServer()
  const ctx = mockCtx({ services: { webServer } })
  apply(ctx, webhookConfig())

  assert.equal(webServer.routes.length, 1)
  assert.deepEqual(
    { kind: webServer.routes[0].kind, path: webServer.routes[0].path },
    { kind: 'exact', path: FOCUS_ROUTE },
  )
  assert.equal(typeof webServer.routes[0].handler, 'function')
  assert.deepEqual(ctx.effects.map((entry) => entry.label), ['dsh-notification: focus route'])
})

test('apply loads without a web server (headless profiles)', () => {
  const ctx = mockCtx()
  assert.doesNotThrow(() => apply(ctx, webhookConfig()))
  assert.deepEqual(ctx.effects, [])
})
