#!/usr/bin/env node
/**
 * Verifies that the resolved `tauri` crate version (Cargo.lock) and the
 * resolved `@tauri-apps/api` package version (package-lock.json) share the
 * same major.minor. Tauri itself prints a warning when these drift, and a
 * mismatch can cause cross-window IPC events to silently fail because the
 * JS↔Rust event protocol can shift between minor versions.
 *
 * Run via `npm run check:versions` or as a CI step. Exits 0 on parity, 1
 * on mismatch, 2 if either lockfile entry can't be parsed.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function fail(code, msg) {
  console.error(msg)
  process.exit(code)
}

// App versions must also match: the native config drives updater comparisons.
const packageVersion = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).version
const configVersion = JSON.parse(readFileSync(resolve(ROOT, 'src-tauri/tauri.conf.json'), 'utf8')).version
const cargoManifest = readFileSync(resolve(ROOT, 'src-tauri/Cargo.toml'), 'utf8')
const cargoVersion = cargoManifest.match(/\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m)?.[1]
if (!cargoVersion || !packageVersion || !configVersion) fail(2, 'Could not read app versions')
if (new Set([packageVersion, configVersion, cargoVersion]).size !== 1) {
  fail(1, 'App version mismatch: package.json=' + packageVersion + ', tauri.conf.json=' + configVersion + ', Cargo.toml=' + cargoVersion)
}
console.log('App version parity OK: ' + packageVersion)

// Cargo.lock: find the [[package]] block whose name is "tauri" (not
// tauri-build/tauri-utils/etc.). Use a multiline regex with name-then-version
// because version comes immediately after name in cargo's output.
const cargoLock = readFileSync(resolve(ROOT, 'src-tauri/Cargo.lock'), 'utf8')
const cargoMatch = cargoLock.match(
  /\[\[package\]\]\s+name\s*=\s*"tauri"\s+version\s*=\s*"([^"]+)"/,
)
if (!cargoMatch) fail(2, 'Could not find `tauri` package in src-tauri/Cargo.lock')
const rustVersion = cargoMatch[1]

// package-lock.json : npm v7+ format keys packages by node_modules path.
const pkgLock = JSON.parse(readFileSync(resolve(ROOT, 'package-lock.json'), 'utf8'))
const apiEntry = pkgLock.packages?.['node_modules/@tauri-apps/api']
if (!apiEntry?.version) {
  fail(2, 'Could not find `@tauri-apps/api` in package-lock.json')
}
const jsVersion = apiEntry.version

const majorMinor = (v) => v.split('.').slice(0, 2).join('.')
const rustMM = majorMinor(rustVersion)
const jsMM = majorMinor(jsVersion)

if (rustMM !== jsMM) {
  fail(
    1,
    [
      'Tauri version mismatch detected:',
      `  Rust crate (Cargo.lock):       tauri ${rustVersion}  (major.minor ${rustMM})`,
      `  JS package (package-lock.json): @tauri-apps/api ${jsVersion}  (major.minor ${jsMM})`,
      '',
      'These must share the same major.minor. Bump whichever is behind:',
      `  cargo update -p tauri --manifest-path src-tauri/Cargo.toml`,
      `  npm install @tauri-apps/api@^${rustMM} @tauri-apps/cli@^${rustMM}`,
    ].join('\n'),
  )
}

console.log(`Tauri version parity OK: tauri ${rustVersion} <-> @tauri-apps/api ${jsVersion}`)
