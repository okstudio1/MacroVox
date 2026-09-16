import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { validateCsp } from '../check-csp.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const csp = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8')).app.security.csp

test('production webview policy permits BYOK requests and history playback', () => {
  const pages = Object.fromEntries(['dictation.html', 'settings.html'].map(name =>
    [name, readFileSync(join(root, 'src/renderer', name), 'utf8')]))
  assert.deepEqual(validateCsp(csp, pages), [])
})
test('CSP guard detects both regressions from the security review', () => {
  assert.ok(validateCsp(csp.replace('https://api.anthropic.com', ''), {}).some(e => e.includes('api.anthropic.com')))
  assert.ok(validateCsp(csp.replace(/media-src[^;]*;/, ''), {}).some(e => e.includes('media-src')))
  assert.ok(validateCsp(csp, { page: '<meta http-equiv="Content-Security-Policy" content="default-src self">' }).some(e => e.includes('response header')))
})

function checkVersions(t, overrides = {}) {
  const prefix = join(tmpdir(), 'macrovox-version-check-')
  const dir = mkdtempSync(prefix)
  t.after(() => {
    // Delete only this test's generated directory, never an external fixture.
    assert.ok(resolve(dir).startsWith(resolve(prefix)))
    rmSync(dir, { recursive: true, force: true })
  })
  mkdirSync(join(dir, 'scripts'))
  mkdirSync(join(dir, 'src-tauri'))
  copyFileSync(join(root, 'scripts/check-tauri-versions.mjs'), join(dir, 'scripts/check-tauri-versions.mjs'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: overrides.packageVersion || '1.0.9' }))
  writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/@tauri-apps/api': { version: overrides.jsVersion || '2.11.0' } } }))
  writeFileSync(join(dir, 'src-tauri/tauri.conf.json'), JSON.stringify({ version: overrides.configVersion || '1.0.9' }))
  writeFileSync(join(dir, 'src-tauri/Cargo.toml'), '[package]\nname = "macrovox"\nversion = "' + (overrides.cargoVersion || '1.0.9') + '"\n')
  writeFileSync(join(dir, 'src-tauri/Cargo.lock'), '[[package]]\nname = "tauri"\nversion = "2.11.1"\n')
  return spawnSync(process.execPath, [join(dir, 'scripts/check-tauri-versions.mjs')], { encoding: 'utf8' })
}
test('version gate accepts app parity and compatible Tauri patch versions', t => {
  assert.equal(checkVersions(t).status, 0)
})
test('version gate rejects a stale native app version', t => {
  const result = checkVersions(t, { cargoVersion: '1.0.8' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /App version mismatch/)
})
test('version gate rejects the wrong Tauri event protocol version', t => {
  const result = checkVersions(t, { jsVersion: '2.10.0' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Tauri version mismatch/)
})
