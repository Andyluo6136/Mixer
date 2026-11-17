// Spotify login using the Authorization Code flow with PKCE.
// Docs: https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow
//
// Checkpoint 1: redirect to Spotify and back (login, readCallback).
// Checkpoint 2: exchange the returned `code` for an access token (exchangeCode, getStoredToken).
// Checkpoint 4: refresh the token automatically when it expires (getAccessToken).

export const CLIENT_ID = import.meta.env.VITE_SPOTIFY_CLIENT_ID as string | undefined
export const REDIRECT_URI = import.meta.env.VITE_SPOTIFY_REDIRECT_URI as string | undefined

// Permissions we ask the user for. Enough to read their profile and playlists.
const SCOPES = ['user-read-private', 'playlist-read-private', 'playlist-read-collaborative']

// Where we keep values that must survive the round trip to Spotify and back.
export const STORAGE = {
  verifier: 'spotify_code_verifier',
  state: 'spotify_auth_state',
  token: 'spotify_token', // JSON-encoded StoredToken, kept in localStorage
}

export function isConfigured(): boolean {
  return Boolean(CLIENT_ID && CLIENT_ID !== 'your-client-id' && REDIRECT_URI)
}

/** Random hex string, from the browser's cryptographically secure generator. */
function randomString(byteCount: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteCount))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** PKCE "code challenge": SHA-256 of the verifier, base64url-encoded without padding. */
async function codeChallengeFor(verifier: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/** Sends the browser to Spotify's login/consent page. Spotify redirects back to REDIRECT_URI. */
export async function login(): Promise<void> {
  if (!isConfigured()) throw new Error('Set VITE_SPOTIFY_CLIENT_ID in .env, then restart `npm run dev`')

  // The verifier stays secret in this browser; only its hash (the challenge) goes to Spotify.
  // Later, the token request proves it's us by sending the original verifier.
  const verifier = randomString(64)
  // `state` protects against forged callbacks: Spotify echoes it back and we check it matches.
  const state = randomString(16)
  sessionStorage.setItem(STORAGE.verifier, verifier)
  sessionStorage.setItem(STORAGE.state, state)

  const params = new URLSearchParams({
    client_id: CLIENT_ID!,
    response_type: 'code',
    redirect_uri: REDIRECT_URI!,
    scope: SCOPES.join(' '),
    code_challenge_method: 'S256',
    code_challenge: await codeChallengeFor(verifier),
    state,
  })
  window.location.assign(`https://accounts.spotify.com/authorize?${params}`)
}

export interface CallbackResult {
  code: string | null
  error: string | null // e.g. "access_denied" if the user clicked Cancel
  stateMatches: boolean
}

/** Reads what Spotify put in the URL when it redirected back to /callback. */
export function readCallback(): CallbackResult {
  const params = new URLSearchParams(window.location.search)
  return {
    code: params.get('code'),
    error: params.get('error'),
    stateMatches: params.get('state') !== null && params.get('state') === sessionStorage.getItem(STORAGE.state),
  }
}

// ---------- Checkpoint 2: code → access token ----------

export interface StoredToken {
  accessToken: string // sent as "Authorization: Bearer <token>" on API calls
  refreshToken: string | null // used in a later checkpoint to get a new token without logging in again
  expiresAt: number // ms since epoch
  scope: string // permissions actually granted
}

// The code is single-use. React StrictMode runs effects twice in development, which would
// send two token requests, and the second would fail with "invalid_grant". Caching the promise
// per code makes repeat calls share the first request.
const pendingExchanges = new Map<string, Promise<StoredToken>>()

export function exchangeCode(code: string): Promise<StoredToken> {
  let pending = pendingExchanges.get(code)
  if (!pending) {
    pending = requestToken(code)
    pendingExchanges.set(code, pending)
  }
  return pending
}

async function requestToken(code: string): Promise<StoredToken> {
  const verifier = sessionStorage.getItem(STORAGE.verifier)
  if (!verifier) throw new Error('Code verifier missing. Start the login again from this browser tab.')

  const token = await postToToken({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI!, // must be identical to the one used in login()
    code_verifier: verifier, // proves we're the app that started this login
  })
  // The one-time login values have done their job.
  sessionStorage.removeItem(STORAGE.verifier)
  sessionStorage.removeItem(STORAGE.state)
  return token
}

/** POSTs to Spotify's token endpoint (used for both login and refresh) and saves the result. */
async function postToToken(params: Record<string, string>, previous?: StoredToken): Promise<StoredToken> {
  // Spotify's token endpoint expects form-encoded data, not JSON.
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID!, ...params }),
  })
  const body = await res.json()
  if (!res.ok) {
    // e.g. { error: "invalid_grant", error_description: "Invalid authorization code" }
    throw new Error(`Token request failed (${res.status}): ${body.error_description ?? body.error ?? 'unknown error'}`)
  }

  const token: StoredToken = {
    accessToken: body.access_token,
    // A refresh response may or may not include a new refresh token; keep the old one if not.
    refreshToken: body.refresh_token ?? previous?.refreshToken ?? null,
    expiresAt: Date.now() + body.expires_in * 1000, // expires_in is in seconds (normally 3600)
    scope: body.scope ?? previous?.scope ?? '',
  }
  localStorage.setItem(STORAGE.token, JSON.stringify(token))
  return token
}

/** The saved token (possibly expired; getAccessToken refreshes it), or null if not logged in. */
export function getStoredToken(): StoredToken | null {
  const raw = localStorage.getItem(STORAGE.token)
  if (!raw) return null
  try {
    return JSON.parse(raw) as StoredToken
  } catch {
    return null
  }
}

export function logout(): void {
  localStorage.removeItem(STORAGE.token)
}

// ---------- Checkpoint 4: keep the token fresh ----------

/** The user has to log in again: no token, or Spotify rejected the refresh. */
export class AuthError extends Error {}

// Several API calls can notice an expired token at the same moment; they share one refresh
// instead of each sending their own.
let refreshing: Promise<StoredToken> | null = null

/** Uses the refresh token to get a new access token without sending the user back to Spotify. */
export function refreshAccessToken(): Promise<StoredToken> {
  if (!refreshing) {
    refreshing = (async () => {
      const current = getStoredToken()
      if (!current?.refreshToken) {
        logout()
        throw new AuthError('Session expired. Log in again.')
      }
      try {
        return await postToToken({ grant_type: 'refresh_token', refresh_token: current.refreshToken }, current)
      } catch {
        // Refresh token revoked (e.g. app access removed in Spotify account settings).
        logout()
        throw new AuthError('Session expired. Log in again.')
      }
    })().finally(() => {
      refreshing = null
    })
  }
  return refreshing
}

/** A usable access token, refreshed first if it expires within the next minute. */
export async function getAccessToken(): Promise<string> {
  const token = getStoredToken()
  if (!token) throw new AuthError('Not logged in')
  if (Date.now() < token.expiresAt - 60_000) return token.accessToken
  return (await refreshAccessToken()).accessToken
}
