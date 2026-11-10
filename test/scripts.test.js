import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const HELPERS = {
  'toast.ps1': readFileSync(new URL('../toast.ps1', import.meta.url), 'utf8'),
  'focus-window.ps1': readFileSync(new URL('../focus-window.ps1', import.meta.url), 'utf8'),
}

/**
 * Both helpers are shipped and executed by Windows PowerShell 5.1, which reads
 * a BOM-less script in the ANSI code page. Keeping them ASCII-only (no BOM, no
 * non-ASCII text; the dynamic title/body travel as process arguments) is what
 * keeps non-English machines from mangling them.
 */
test('the PowerShell helpers are ASCII-only', () => {
  for (const [name, source] of Object.entries(HELPERS)) {
    assert.match(source, /^[\t\n\r\x20-\x7e]*$/, `${name} must be plain ASCII without a BOM`)
    assert.doesNotMatch(source, /\r\n/, `${name} stays LF: the repo sets eol=lf`)
  }
})

test('the helpers keep the stdout markers the host parses', () => {
  assert.match(HELPERS['toast.ps1'], /toast shown appid=/, 'index.js waits for /toast shown/')
  assert.match(HELPERS['focus-window.ps1'], /focus ok/, 'index.js reads /focus ok/')
})

test('both helpers take the host executable used to identify the desktop app', () => {
  for (const [name, source] of Object.entries(HELPERS)) {
    assert.match(source, /-HostExe/, `${name} must accept the host executable`)
    assert.match(source, /\$HostExe/, `${name} must actually branch on it`)
  }
})
