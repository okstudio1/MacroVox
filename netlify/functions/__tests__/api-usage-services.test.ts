/**
 * The rate limiters only work if the database will accept what they write.
 *
 * `api_usage.service` carries a CHECK constraint. The deepgram-grant function
 * shipped logging `service: 'deepgram_grant'` while the constraint still
 * allowed only 'claude' and 'deepgram', so every insert was rejected. The
 * insert is fire-and-forget behind a console.error, so nothing surfaced: the
 * hourly count stayed at zero and the limit never fired. A rate limiter that
 * cannot write is not a rate limiter, and this one fails open.
 *
 * Reading the SQL from disk is unusual for a unit test and is the point: the
 * two halves of this invariant live in different languages and different
 * directories, nothing else compares them, and the failure is silent in
 * production. A mocked Supabase client cannot catch it, because the mock
 * accepts whatever it is given.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const FUNCTIONS_DIR = 'netlify/functions'
const MIGRATIONS_DIR = 'supabase/migrations'

/** Service values the CHECK constraint permits, per the latest migration. */
function allowedServices(): string[] {
  const sql = readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort()
    .map(f => readFileSync(join(MIGRATIONS_DIR, f), 'utf8'))
    .join('\n')

  // Migrations are applied in filename order and a later one replaces the
  // constraint, so the last CHECK in the concatenation is the live one.
  const checks = [...sql.matchAll(/service\s+IN\s*\(([^)]*)\)/gi)]
  expect(checks.length, 'no CHECK on api_usage.service found in any migration').toBeGreaterThan(0)

  const last = checks[checks.length - 1][1]
  return [...last.matchAll(/'([^']+)'/g)].map(m => m[1])
}

/** Service values the functions actually insert. */
function loggedServices(): { file: string, service: string }[] {
  return readdirSync(FUNCTIONS_DIR)
    .filter(f => f.endsWith('.ts'))
    .flatMap(file => {
      const src = readFileSync(join(FUNCTIONS_DIR, file), 'utf8')
      return [...src.matchAll(/service:\s*'([^']+)'/g)].map(m => ({ file, service: m[1] }))
    })
}

describe('api_usage.service', () => {
  it('accepts every value the functions actually write', () => {
    const allowed = allowedServices()
    const logged = loggedServices()

    // If this is zero the regex has drifted and the test below is vacuous.
    expect(logged.length, 'found no api_usage inserts to check').toBeGreaterThan(0)

    for (const { file, service } of logged) {
      expect(
        allowed,
        `${file} writes service '${service}', which the CHECK constraint rejects`,
      ).toContain(service)
    }
  })
})
