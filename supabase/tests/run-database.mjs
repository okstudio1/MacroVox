/** Exercise migrations and concurrency in a disposable local PostgreSQL database.
 * Requires psql and TEST_DATABASE_URL pointing at a local test server. Never uses
 * SUPABASE_URL, a production database URL, or a provider credential.
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const configured = process.env.TEST_DATABASE_URL
if (!configured) throw new Error('Set TEST_DATABASE_URL to a disposable local PostgreSQL server')
const admin = new URL(configured)
if (!['localhost', '127.0.0.1', '[::1]'].includes(admin.hostname)) {
  throw new Error('Database tests accept only a local test server')
}
const database = `macrovox_test_${randomUUID().replaceAll('-', '')}`
if (!/^macrovox_test_[a-f0-9]{32}$/.test(database)) throw new Error('Invalid disposable database name')
const connection = new URL(admin)
connection.pathname = `/${database}`

function psql(url, args) {
  return new Promise((resolveResult, reject) => {
    const child = spawn('psql', ['--no-psqlrc', '--no-password', '--dbname', url.href, '--quiet', '--tuples-only', '--no-align',
      '--set', 'ON_ERROR_STOP=1', ...args], {
      env: { ...process.env, PGCONNECT_TIMEOUT: '5' },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    let errors = ''
    child.stdout.on('data', data => { output += data })
    child.stderr.on('data', data => { errors += data })
    child.on('error', reject)
    child.on('exit', code => code === 0
      ? resolveResult(output.trim())
      : reject(new Error(`psql exited ${code}: ${errors}`)))
  })
}
const sql = statement => psql(connection, ['--command', statement])
const user = randomUUID()
let created = false
try {
  await psql(admin, ['--command', `CREATE DATABASE ${database}`])
  created = true
  await sql(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
    END $$;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
    GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;
    INSERT INTO auth.users(id) VALUES ('00000000-0000-0000-0000-000000000099');
    CREATE TABLE public.managed_api_keys (
      user_id uuid PRIMARY KEY REFERENCES auth.users(id), deepgram_key text, anthropic_key text
    );
    INSERT INTO public.managed_api_keys VALUES (
      '00000000-0000-0000-0000-000000000099', 'fake-legacy-deepgram', 'fake-legacy-anthropic'
    );
    ALTER TABLE public.managed_api_keys ENABLE ROW LEVEL SECURITY;
    CREATE POLICY "Users read own keys" ON public.managed_api_keys FOR SELECT
      TO authenticated USING (auth.uid() = user_id);
    GRANT SELECT ON public.managed_api_keys TO authenticated;

  `)
  for (const migration of readdirSync(resolve(root, 'migrations')).filter(name => name.endsWith('.sql')).sort()) {
    await psql(connection, ['--single-transaction', '--file', resolve(root, 'migrations', migration)])
  }
  await psql(connection, ['--file', resolve(root, 'tests/assertions.sql')])
  await sql(`INSERT INTO auth.users(id) VALUES ('${user}');
    INSERT INTO public.api_usage(user_id, service)
    SELECT '${user}', 'claude' FROM generate_series(1, 199)`)
  const reservations = await Promise.all(Array.from({ length: 25 }, () =>
    sql(`SET ROLE service_role; SELECT public.reserve_api_quota('${user}', 'claude', 200, 3600)`)))
  assert.equal(reservations.filter(value => value === 't').length, 1, 'Exactly one concurrent request may take the last quota slot')
  assert.equal(await sql(`SELECT count(*) FROM public.api_usage WHERE user_id = '${user}' AND service = 'claude'`), '200')
  const checkouts = await Promise.all(Array.from({ length: 10 }, () =>
    sql(`SET ROLE service_role; SELECT reservation_id FROM public.begin_checkout('${user}', 'pro')`)))
  assert.equal(new Set(checkouts).size, 1, 'Concurrent checkout must reuse one reservation and idempotency key')
  assert.match(checkouts[0], /^[a-f0-9-]{36}$/)
  const event = `evt_test_${randomUUID()}`
  const claims = await Promise.all(Array.from({ length: 10 }, () =>
    sql(`SET ROLE service_role; SELECT public.begin_stripe_webhook_event('${event}', 'customer.subscription.updated', 100)`)))
  assert.equal(claims.filter(value => value === 'process').length, 1, 'Only one webhook worker may claim the event')
  assert.equal(claims.filter(value => value === 'busy').length, 9)
  console.log('Database migration, permission, quota, checkout, and webhook concurrency checks passed')
} finally {
  if (created) await psql(admin, ['--command', `DROP DATABASE ${database} WITH (FORCE)`])
}
