import { useCallback, useEffect, useState } from 'react'
import {
  exchangeCode,
  getStoredToken,
  isConfigured,
  login,
  logout,
  readCallback,
  REDIRECT_URI,
  AuthError,
  type StoredToken,
} from './auth'
import {
  ApiError,
  getPlaylists,
  getPlaylistTracks,
  getProfile,
  type Playlist,
  type PlaylistTracks,
  type Profile,
} from './spotify'
import './App.css'

function App() {
  const [token, setToken] = useState<StoredToken | null>(getStoredToken)
  const [onCallbackPage, setOnCallbackPage] = useState(window.location.pathname === '/callback')

  const finishLogin = (t: StoredToken) => {
    // Swap /callback?code=... for / so a reload doesn't try to reuse the single-use code.
    window.history.replaceState(null, '', '/')
    setOnCallbackPage(false)
    setToken(t)
  }

  // Stable identity, because LoggedInView's fetch effect depends on it.
  const handleLogout = useCallback(() => {
    logout()
    setToken(null)
  }, [])

  let view
  if (onCallbackPage) view = <CallbackView onToken={finishLogin} />
  else if (token) view = <LoggedInView token={token} onLogout={handleLogout} />
  else view = <LoginView />
  return <main>{view}</main>
}

function LoginView() {
  const [error, setError] = useState<string | null>(null)

  if (!isConfigured()) {
    return (
      <section className="card">
        <h1>Mixer</h1>
        <p className="error">
          Missing Spotify Client ID. Put it in <code>.env</code> as <code>VITE_SPOTIFY_CLIENT_ID</code>, then restart{' '}
          <code>npm run dev</code>.
        </p>
      </section>
    )
  }

  return (
    <section className="card">
      <h1>Mixer</h1>
      <p>Connect your Spotify account to load your playlists.</p>
      <button onClick={() => login().catch((e: Error) => setError(e.message))}>Log in with Spotify</button>
      {error && <p className="error">{error}</p>}
      <p className="hint">
        Redirects back to <code>{REDIRECT_URI}</code>
      </p>
    </section>
  )
}

function CallbackView({ onToken }: { onToken: (t: StoredToken) => void }) {
  const [{ code, error, stateMatches }] = useState(readCallback)
  const [exchangeError, setExchangeError] = useState<string | null>(null)

  const problem = error
    ? `Spotify returned an error: ${error}`
    : !code
      ? 'No code in the URL.'
      : !stateMatches
        ? "State mismatch: this callback didn't come from our login. Try logging in again."
        : null

  useEffect(() => {
    if (problem || !code) return
    let cancelled = false
    exchangeCode(code)
      .then((t) => {
        if (!cancelled) onToken(t)
      })
      .catch((e: Error) => {
        if (!cancelled) setExchangeError(e.message)
      })
    return () => {
      cancelled = true
    }
  }, [code, problem, onToken])

  return (
    <section className="card">
      <h1>Back from Spotify</h1>
      {problem || exchangeError ? (
        <p className="error">{problem ?? exchangeError}</p>
      ) : (
        <p>Exchanging code for an access token…</p>
      )}
      <p>
        <a href="/">← Start over</a>
      </p>
    </section>
  )
}

/** Turns an error into a message for the user, or null if it means "log in again". */
function describeError(e: unknown): string | null {
  if (e instanceof AuthError) return null
  // Only generic 403s; the "can't read that playlist" 403 already has its own message.
  if (e instanceof ApiError && e.status === 403 && e.message.startsWith('Spotify API error')) {
    // Development-mode apps only work for accounts listed under User Management.
    return 'Spotify refused access (403). Is your account added under User Management in the dashboard?'
  }
  return e instanceof Error ? e.message : String(e)
}

function LoggedInView({ token, onLogout }: { token: StoredToken; onLogout: () => void }) {
  const [profile, setProfile] = useState<Profile | null>(null)
  const [playlists, setPlaylists] = useState<Playlist[] | null>(null)
  const [selected, setSelected] = useState<Playlist | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    // Both requests are independent, so run them in parallel.
    Promise.all([getProfile(), getPlaylists()])
      .then(([p, lists]) => {
        if (cancelled) return
        setProfile(p)
        setPlaylists(lists)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        const message = describeError(e)
        if (message === null) onLogout() // token can't be refreshed: back to the login screen
        else setError(message)
      })
    return () => {
      cancelled = true
    }
  }, [token, onLogout])

  return (
    <section className="card">
      <header className="profile">
        {profile?.imageUrl && <img src={profile.imageUrl} alt="" className="avatar" />}
        <h1>{profile ? profile.displayName : 'Mixer'}</h1>
        <button className="secondary" onClick={onLogout}>
          Log out
        </button>
      </header>

      {error && <p className="error">{error}</p>}
      {!error && !playlists && <p>Loading playlists…</p>}

      {selected ? (
        <PlaylistView playlist={selected} onBack={() => setSelected(null)} onLogout={onLogout} />
      ) : (
        playlists && (
          <>
            <h2>Your playlists ({playlists.length})</h2>
            {playlists.length === 0 ? (
              <p className="hint">No playlists on this account.</p>
            ) : (
              <ul className="playlists">
                {playlists.map((p) => (
                  <li key={p.id}>
                    <button className="row" onClick={() => setSelected(p)}>
                      <Cover url={p.imageUrl} />
                      <div>
                        <div className="name">{p.name}</div>
                        <div className="hint">
                          {p.trackCount} tracks · by {p.owner}
                        </div>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )
      )}
    </section>
  )
}

// Tracks already fetched this session, by playlist id, so going back and forth doesn't refetch.
const trackCache = new Map<string, PlaylistTracks>()

function PlaylistView({ playlist, onBack, onLogout }: { playlist: Playlist; onBack: () => void; onLogout: () => void }) {
  const [result, setResult] = useState<PlaylistTracks | null>(() => trackCache.get(playlist.id) ?? null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (trackCache.has(playlist.id)) return
    let cancelled = false
    getPlaylistTracks(playlist.id)
      .then((r) => {
        trackCache.set(playlist.id, r)
        if (!cancelled) setResult(r)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        const message = describeError(e)
        if (message === null) onLogout()
        else setError(message)
      })
    return () => {
      cancelled = true
    }
  }, [playlist.id, onLogout])

  return (
    <>
      <button className="secondary back" onClick={onBack}>
        ← All playlists
      </button>
      <div className="playlist-header">
        <Cover url={playlist.imageUrl} />
        <div>
          <h2>{playlist.name}</h2>
          {result && (
            <div className="hint">
              {result.tracks.length} tracks · {formatDuration(result.tracks.reduce((sum, t) => sum + t.durationMs, 0))}
              {result.skipped > 0 && ` · ${result.skipped} skipped (episodes, local files or unavailable)`}
            </div>
          )}
        </div>
      </div>

      {error && <p className="error">{error}</p>}
      {!error && !result && <p>Loading tracks…</p>}

      {result && (
        <ol className="tracks">
          {result.tracks.map((t, i) => (
            // The same song can appear twice in a playlist, so the id alone isn't a unique key.
            <li key={`${t.id}-${i}`}>
              <span className="num">{i + 1}</span>
              <Cover url={t.imageUrl} small />
              <div className="info">
                <div className="name">{t.name}</div>
                <div className="hint">
                  {t.artists.join(', ')} · {t.album}
                </div>
              </div>
              <span className="duration">{formatDuration(t.durationMs)}</span>
            </li>
          ))}
        </ol>
      )}
    </>
  )
}

function Cover({ url, small }: { url: string | null; small?: boolean }) {
  const className = small ? 'cover small' : 'cover'
  return url ? <img src={url} alt="" className={className} /> : <div className={className} />
}

/** 215000 → "3:35"; an hour or more → "1:02:05". */
function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

export default App
