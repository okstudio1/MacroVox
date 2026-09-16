const APP_ORIGINS = new Set([
  'https://macrovox.tech',
  'tauri://localhost',
  'http://tauri.localhost',
  'https://tauri.localhost',
])

export function allowedOrigin(value: string | null): string | null {
  const origin = (value ?? '').toLowerCase()
  return APP_ORIGINS.has(origin) ? origin : null
}
