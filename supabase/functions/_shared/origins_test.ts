import { assertEquals } from 'jsr:@std/assert@1.0.19'
import { allowedOrigin } from './origins.ts'

Deno.test('allows the Windows default Tauri origin', () => {
  assertEquals(allowedOrigin('http://tauri.localhost'), 'http://tauri.localhost')
})

Deno.test('rejects a lookalike Tauri origin', () => {
  assertEquals(allowedOrigin('http://tauri.localhost.evil.example'), null)
})
