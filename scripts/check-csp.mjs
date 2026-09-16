#!/usr/bin/env node
/** Check the production CSP contract before building or releasing either webview. */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Return actionable errors for missing permissions or a conflicting HTML policy. */
export function validateCsp(csp, htmlDocuments) {
  const errors = []
  if (typeof csp !== 'string') return ['app.security.csp must be a string']
  const directives = new Map(csp.split(';').map(part => {
    const [name, ...values] = part.trim().split(/\s+/)
    return [name, values]
  }))
  const required = {
    'default-src': ["'self'"],
    'script-src': ["'self'"],
    'connect-src': ["'self'", 'https://api.anthropic.com', 'https://macrovox.tech'],
    'media-src': ["'self'", 'data:'],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
  }
  for (const [name, values] of Object.entries(required)) {
    for (const value of values) {
      if (!directives.get(name)?.includes(value)) errors.push(name + ' must include ' + value)
    }
  }
  for (const [name, html] of Object.entries(htmlDocuments)) {
    if (/http-equiv\s*=\s*["']?Content-Security-Policy/i.test(html)) {
      errors.push(name + ': remove the HTML CSP; the Tauri response header is authoritative')
    }
  }
  return errors
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const config = JSON.parse(readFileSync(resolve(root, 'src-tauri/tauri.conf.json'), 'utf8'))
  const pages = Object.fromEntries(['dictation.html', 'settings.html'].map(name =>
    [name, readFileSync(resolve(root, 'src/renderer', name), 'utf8')]))
  const errors = validateCsp(config.app.security.csp, pages)
  if (errors.length) {
    console.error(errors.join('\n'))
    process.exitCode = 1
  } else {
    console.log('CSP contract OK: one production policy for both webviews')
  }
}
