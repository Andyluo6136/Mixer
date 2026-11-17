// Spotify Web API calls. Every request sends the access token from checkpoint 2.
// Reference: https://developer.spotify.com/documentation/web-api

import { AuthError, getAccessToken, refreshAccessToken } from './auth'

const API = 'https://api.spotify.com/v1'

/** A failed API call, with the HTTP status so callers can react to specific cases. */
export class ApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function apiGet<T>(pathOrUrl: string): Promise<T> {
  // Paging responses give absolute `next` URLs; our own calls pass a path like "/me".
  const url = pathOrUrl.startsWith('https://') ? pathOrUrl : API + pathOrUrl
  let refreshed = false

  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${await getAccessToken()}` } })

    if (res.ok) return res.json() as Promise<T>

    if (res.status === 401 && !refreshed) {
      // Token rejected before its expiry time (e.g. revoked). Refresh once and retry.
      refreshed = true
      await refreshAccessToken()
      continue
    }
    if (res.status === 429) {
      // Rate limited: Spotify says how many seconds to wait.
      await sleep(Number(res.headers.get('Retry-After') ?? 1) * 1000)
      continue
    }
    if (res.status === 401) throw new AuthError('Spotify session expired. Log in again.')
    throw new ApiError(res.status, `Spotify API error ${res.status} on ${url}`)
  }
  throw new ApiError(429, 'Spotify kept rate-limiting the request. Try again in a minute.')
}

/** Spotify returns lists in pages; follow `next` until it's null to get everything. */
async function getAllPages<T>(firstPath: string): Promise<T[]> {
  const items: T[] = []
  let next: string | null = firstPath
  while (next) {
    const page: { items: T[]; next: string | null } = await apiGet(next)
    items.push(...page.items)
    next = page.next
  }
  return items
}

// ---------- profile ----------

export interface Profile {
  id: string
  displayName: string
  imageUrl: string | null
}

interface RawImage {
  url: string
  width: number | null
}

/** Smallest image, which is all a thumbnail needs (Spotify lists sizes largest-first). */
function smallestImage(images: RawImage[] | null | undefined): string | null {
  return images?.length ? images[images.length - 1].url : null
}

export async function getProfile(): Promise<Profile> {
  const me = await apiGet<{ id: string; display_name: string | null; images?: RawImage[] }>('/me')
  return { id: me.id, displayName: me.display_name ?? me.id, imageUrl: smallestImage(me.images) }
}

// ---------- playlists ----------

export interface Playlist {
  id: string
  name: string
  owner: string
  trackCount: number
  imageUrl: string | null
}

interface RawPlaylist {
  id: string
  name: string
  owner: { id: string; display_name?: string | null }
  images: RawImage[] | null
  tracks?: { total: number } // track count lives here…
  items?: { total: number } // …or here, on newer API responses
}

/** Every playlist the user owns or follows, in the order shown in their Spotify sidebar. */
export async function getPlaylists(): Promise<Playlist[]> {
  const raw = await getAllPages<RawPlaylist | null>('/me/playlists?limit=50') // 50 is the max page size
  return raw
    .filter((p): p is RawPlaylist => p !== null) // deleted/unavailable playlists come back as null
    .map((p) => ({
      id: p.id,
      name: p.name,
      owner: p.owner.display_name ?? p.owner.id,
      trackCount: p.tracks?.total ?? p.items?.total ?? 0,
      imageUrl: smallestImage(p.images),
    }))
}

// ---------- tracks ----------

export interface Track {
  id: string
  uri: string // "spotify:track:<id>", the form playback and later steps use
  name: string
  artists: string[]
  album: string
  durationMs: number
  imageUrl: string | null
}

interface RawTrack {
  type: 'track' | 'episode'
  id: string | null
  uri: string
  name: string
  is_local?: boolean
  artists: { name: string }[]
  album?: { name: string; images: RawImage[] }
  duration_ms: number
}

/** One playlist row. The track lives in `track`, or `item` on newer API responses. */
interface RawPlaylistItem {
  track?: RawTrack | null
  item?: RawTrack | null
}

export interface PlaylistTracks {
  tracks: Track[]
  skipped: number // podcast episodes, local files and removed tracks
}

export async function getPlaylistTracks(playlistId: string): Promise<PlaylistTracks> {
  let raw: RawPlaylistItem[]
  try {
    raw = await getAllPages<RawPlaylistItem>(`/playlists/${playlistId}/items?limit=100`) // 100 is the max page size
  } catch (e) {
    // Older API versions only have the /tracks path.
    if (!(e instanceof ApiError && e.status === 404)) throw describePlaylistError(e)
    try {
      raw = await getAllPages<RawPlaylistItem>(`/playlists/${playlistId}/tracks?limit=100`)
    } catch (e2) {
      throw describePlaylistError(e2)
    }
  }

  const tracks: Track[] = []
  let skipped = 0
  for (const row of raw) {
    const t = row.track ?? row.item
    // null = removed from Spotify; episodes aren't songs; local files have no Spotify id.
    if (!t || t.type !== 'track' || !t.id || t.is_local) {
      skipped++
      continue
    }
    tracks.push({
      id: t.id,
      uri: t.uri,
      name: t.name,
      artists: t.artists.map((a) => a.name),
      album: t.album?.name ?? '',
      durationMs: t.duration_ms,
      imageUrl: smallestImage(t.album?.images),
    })
  }
  return { tracks, skipped }
}

function describePlaylistError(e: unknown): unknown {
  if (e instanceof ApiError && (e.status === 403 || e.status === 404)) {
    // Spotify blocks newer apps from reading its own editorial and algorithmic playlists
    // (Discover Weekly, Daily Mix, "Today's Top Hits", ...).
    return new ApiError(
      e.status,
      "Spotify won't let this app read that playlist. This happens with Spotify-made playlists (Discover Weekly, Daily Mix, editorial lists), which are blocked for third-party apps.",
    )
  }
  return e
}
