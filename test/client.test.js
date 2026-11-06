import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const SOURCE = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

/**
 * Load the browser bundle into a stubbed page and a stubbed client context.
 *
 * The bundle is a classic script that registers itself on
 * `window.__ModuleLoader__`, so a `vm` context reproduces it without a browser
 * or a module graph — including a fake clock, which the turn-duration gate
 * needs.
 *
 * @param {object} options - page state: `hidden`, `focused`, `permission`, `clock`.
 * @returns the registered client half plus the page and controller stubs.
 */
function harness({ hidden = true, focused = false, permission = 'granted', clock = { now: 0 } } = {}) {
  const popups = []
  const focusedWindow = []

  function FakeDate() {}
  FakeDate.now = () => clock.now

  class FakeNotification {
    constructor(title, options) {
      this.title = title
      this.options = options
      popups.push(this)
    }
    static requestPermission() {
      return Promise.resolve('granted')
    }
    close() {}
  }
  FakeNotification.permission = permission

  const document = {
    visibilityState: hidden ? 'hidden' : 'visible',
    hasFocus: () => focused,
  }

  let registered
  const window = {
    __ModuleLoader__: { load: (row) => { registered = row } },
    addEventListener() {},
    removeEventListener() {},
    focus: () => focusedWindow.push(true),
  }

  const sandbox = { window, document, Notification: FakeNotification, Date: FakeDate, console }
  vm.createContext(sandbox)
  vm.runInContext(SOURCE, sandbox)

  const exported = registered.factory(() => ({}))

  // Client services the bundle reaches for. `sessions.list` is the catalog; the
  // pending interactions live on `uiSession.sessionStatus`, as in the real client.
  const catalog = { ids: [], byId: {}, phase: 'ready' }
  const sessionStatus = new Map()
  const listListeners = new Set()
  const statusListeners = new Set()
  const opened = []
  const disposers = []

  const services = {
    sessions: {
      list: {
        getSnapshot: () => catalog,
        subscribe: (listener) => {
          listListeners.add(listener)
          return () => listListeners.delete(listener)
        },
      },
    },
    uiSession: {
      sessionStatus: {
        getSnapshot: () => sessionStatus,
        subscribe: (listener) => {
          statusListeners.add(listener)
          return () => statusListeners.delete(listener)
        },
      },
    },
    uiWorkspace: { openSession: (sessionId) => opened.push(sessionId) },
  }

  const ctx = {
    get: (name) => services[name],
    effect: (register) => { disposers.push(register()) },
  }

  return {
    exported,
    popups,
    focusedWindow,
    opened,
    catalog,
    sessionStatus,
    dispose: () => disposers.forEach((dispose) => dispose()),
    apply: (config = {}) => exported.apply(ctx, config),
    /** Publish a catalog change, as `ctx.sessions.list` does. */
    publish: () => [...listListeners].forEach((listener) => listener()),
    /** Publish a status change, as `ctx.uiSession.sessionStatus` does. */
    publishStatus: () => [...statusListeners].forEach((listener) => listener()),
    /** Add a catalog row and observe it, so later transitions are visible. */
    addSession(id, { title, running = false, origin } = {}) {
      catalog.ids.push(id)
      catalog.byId[id] = {
        id,
        displayTitle: title ?? id,
        running,
        ...origin === undefined ? {} : { origin },
      }
      sessionStatus.set(id, { running, pendingInteraction: undefined, completionUnread: false })
      this.publish()
    },
    setRunning(id, running) {
      catalog.byId[id] = { ...catalog.byId[id], running }
      sessionStatus.set(id, { ...sessionStatus.get(id), running })
      this.publish()
    },
    setPending(id, pendingInteraction) {
      sessionStatus.set(id, { ...sessionStatus.get(id), pendingInteraction })
      this.publishStatus()
    },
  }
}

test('the bundle registers a client half whose apply never throws without services', () => {
  const page = harness()
  assert.equal(typeof page.exported.apply, 'function')
  assert.deepEqual([...page.exported.inject], ['sessions'])
  page.apply() // no ctx.get('sessions') answer at all
  assert.equal(page.popups.length, 0)
})

test('browser: false keeps the page half inert', () => {
  const page = harness()
  page.apply({ browser: false })
  page.addSession('a', { title: 'Session A', running: true })
  page.setRunning('a', false)
  assert.equal(page.popups.length, 0)
})

test('the first observation seeds without notifying', () => {
  const page = harness()
  page.apply({ minTurnDurationMs: 0 })
  page.addSession('a', { title: 'Session A', running: true })
  assert.equal(page.popups.length, 0)
})

test('a finished turn names its Session and tags the popup per Session', () => {
  const page = harness()
  page.apply({ minTurnDurationMs: 0 })
  page.addSession('a', { title: 'Fix the notifier', running: true })
  page.addSession('b', { title: 'Review the diff', running: true })
  page.setRunning('a', false)
  page.setRunning('b', false)

  assert.deepEqual(page.popups.map((popup) => popup.options.body), [
    'Fix the notifier — Agent finished',
    'Review the diff — Agent finished',
  ])
  assert.deepEqual(page.popups.map((popup) => popup.options.tag), [
    'dsh-notification:a',
    'dsh-notification:b',
  ])
})

test('an untitled Session keeps its raw id out of the body', () => {
  const page = harness()
  page.apply({ minTurnDurationMs: 0 })
  page.addSession('3f9a2c1e', { running: true })
  page.setRunning('3f9a2c1e', false)
  assert.equal(page.popups[0].options.body, 'Agent finished')
})

test('clicking a popup opens the Session that raised it', () => {
  const page = harness()
  page.apply({ minTurnDurationMs: 0 })
  page.addSession('a', { title: 'Session A', running: true })
  page.setRunning('a', false)

  page.popups[0].onclick()
  assert.deepEqual(page.opened, ['a'])
  assert.equal(page.focusedWindow.length, 1)
})

test('a pending interaction notifies from uiSession.sessionStatus', () => {
  const page = harness()
  page.apply({ minTurnDurationMs: 0 })
  page.addSession('a', { title: 'Session A' })
  // The catalog row never carries `pendingInteraction`; the status map does.
  assert.equal(page.catalog.byId.a.pendingInteraction, undefined)

  page.setPending('a', 'approval')
  assert.equal(page.popups.length, 1)
  assert.equal(page.popups[0].options.body, 'Session A — Waiting for you — approval')
  assert.equal(page.popups[0].options.tag, 'dsh-notification:a')
})

test('a turn below minTurnDurationMs stays quiet', () => {
  const clock = { now: 0 }
  const page = harness({ clock })
  page.apply({ minTurnDurationMs: 5000 })
  page.addSession('a', { title: 'Session A' })
  clock.now = 1000
  page.setRunning('a', true)
  clock.now = 3000
  page.setRunning('a', false)
  assert.equal(page.popups.length, 0)

  page.setRunning('a', true)
  clock.now = 14_000
  page.setRunning('a', false)
  assert.equal(page.popups.length, 1)
  assert.equal(page.popups[0].options.body, 'Session A — Agent finished — 11s')
})

test('a subagent Session stays quiet', () => {
  const page = harness()
  page.apply({ minTurnDurationMs: 0 })
  page.addSession('child', { title: 'Explore', running: true, origin: 'subagent' })
  page.setRunning('child', false)
  assert.equal(page.popups.length, 0)
})

test('a visible, focused window stays quiet', () => {
  const page = harness({ hidden: false, focused: true })
  page.apply({ minTurnDurationMs: 0 })
  page.addSession('a', { title: 'Session A', running: true })
  page.setRunning('a', false)
  assert.equal(page.popups.length, 0)
})

test('a visible but unfocused window still notifies', () => {
  const page = harness({ hidden: false, focused: false })
  page.apply({ minTurnDurationMs: 0 })
  page.addSession('a', { title: 'Session A', running: true })
  page.setRunning('a', false)
  assert.equal(page.popups.length, 1)
})

test('browserOnlyWhenHidden: false notifies even while the window has focus', () => {
  const page = harness({ hidden: false, focused: true })
  page.apply({ browserOnlyWhenHidden: false, minTurnDurationMs: 0 })
  page.addSession('a', { title: 'Session A', running: true })
  page.setRunning('a', false)
  assert.equal(page.popups.length, 1)
})

test('a refused permission keeps the page quiet', () => {
  const page = harness({ permission: 'denied' })
  page.apply({ minTurnDurationMs: 0 })
  page.addSession('a', { title: 'Session A', running: true })
  page.setRunning('a', false)
  assert.equal(page.popups.length, 0)
})

test('unloading the plugin drops both subscriptions', () => {
  const page = harness()
  page.apply({ minTurnDurationMs: 0 })
  page.addSession('a', { title: 'Session A', running: true })
  page.dispose()
  page.setRunning('a', false)
  assert.equal(page.popups.length, 0)
})
