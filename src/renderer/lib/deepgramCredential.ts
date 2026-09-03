/**
 * How a Deepgram call authenticates.
 *
 * Two schemes, and they are not interchangeable. A raw API key is presented as
 * `Token <key>`; a short-lived credential from the `deepgram-grant` function is
 * a JWT presented as `Bearer <jwt>`. Sending one as the other is a 401, so the
 * backend takes a tagged value rather than a bare string and decides the header
 * from the tag. See `DeepgramCredential` in `src-tauri/src/deepgram_ws.rs`.
 *
 * The managed key used to be handed to this process, read out of the Supabase
 * `managed_api_keys` table at sign-in and passed down to Rust. That put a
 * shared vendor credential in a desktop app on every Pro and Team machine.
 * It does not any more: the server hands out a token that expires in a minute.
 */

import { API } from '../config'
import { supabase } from './supabase'

export type DeepgramCredential =
  | { kind: 'api_key', value: string }
  | { kind: 'access_token', value: string }

export type CredentialResult =
  | { success: true, credential: DeepgramCredential }
  | { success: false, error: string }

/** The user's own key from Settings, or null if they have not set one. */
export function ownKey(): string | null {
  const key = (localStorage.getItem('user_deepgram_key') || '').trim()
  return key || null
}

/**
 * Resolves the credential for one Deepgram call.
 *
 * Bring-your-own-key wins and short-circuits: the user's own credential, their
 * own money, no round trip and no sign-in.
 *
 * Otherwise this asks the grant function for a token. It is fetched per call
 * rather than cached because it expires in about a minute. That is deliberate:
 * the token only has to be valid during the WebSocket handshake, so a short
 * life costs nothing and a leak is worth almost nothing.
 */
export async function resolveDeepgramCredential(): Promise<CredentialResult> {
  const own = ownKey()
  if (own) return { success: true, credential: { kind: 'api_key', value: own } }

  // Dev-only: let `npm run dev` work without a Netlify function or a sign-in,
  // using the key from `.env`. `import.meta.env.DEV` is false in production
  // builds, so Vite dead-code-eliminates this and the key is not bundled into
  // a release artifact. Treat the VITE_* values as compromised regardless.
  if (import.meta.env.DEV && import.meta.env.VITE_DEEPGRAM_KEY) {
    return { success: true, credential: { kind: 'api_key', value: import.meta.env.VITE_DEEPGRAM_KEY } }
  }

  const { data: { session } } = await supabase.auth.getSession()
  if (!session?.access_token) {
    return { success: false, error: 'Sign in, or add your own Deepgram key in Settings' }
  }

  try {
    const resp = await fetch(API.deepgramGrant, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
      },
    })

    if (resp.status === 403) {
      return { success: false, error: 'A Pro subscription is required, or add your own Deepgram key in Settings' }
    }
    if (resp.status === 429) {
      return { success: false, error: 'Too many requests. Try again shortly.' }
    }
    if (!resp.ok) {
      return { success: false, error: 'Could not authorize transcription. Try again.' }
    }

    const body = await resp.json() as { access_token?: string }
    if (!body.access_token) {
      return { success: false, error: 'Could not authorize transcription. Try again.' }
    }

    return { success: true, credential: { kind: 'access_token', value: body.access_token } }
  } catch {
    // Offline, or the function is down. Either way there is nothing to say
    // beyond "not now", and the message must never carry the response body.
    return { success: false, error: 'Could not reach the transcription service' }
  }
}
