import { create } from 'zustand'
import type { LoudnessTarget, MediaItem, MixIn } from '@/lib/types'

// contract-v15 MixIn. The draft lives outside the page so a trip to Song / Music / SFX to make a
// missing piece ("Generate at clip length") comes back to the same mix.

export const MAX_LANES = 4
export const DUCK_DEFAULT_DB = 10

export interface Lane {
  key: string
  mediaId: string
  title: string
  src: string | null
  duration: number
  offset_s: number
  gain_db: number
  mute: boolean
  solo: boolean
  fade_in_s: number
  fade_out_s: number
  loop: boolean
  duck: boolean
}

export interface ScoreDraft {
  videoId: string | null
  original: { keep: boolean; gain_db: number }
  lanes: Lane[]
  duckDb: number
  loudness: LoudnessTarget | null
}

const EMPTY: ScoreDraft = { videoId: null, original: { keep: true, gain_db: 0 }, lanes: [], duckDb: DUCK_DEFAULT_DB, loudness: null }

export const useScoreDraft = create<ScoreDraft>(() => ({ ...EMPTY }))

let seq = 0

export function laneFrom(m: MediaItem): Lane {
  const d = m.duration_s ?? (typeof m.params?.duration_s === 'number' ? m.params.duration_s : 0)
  return {
    key: `l${++seq}`,
    mediaId: m.id,
    title: m.title || 'Audio',
    src: m.media_url ?? null,
    duration: d || 0,
    offset_s: 0,
    gain_db: 0,
    mute: false,
    solo: false,
    fade_in_s: 0,
    fade_out_s: 0,
    loop: false,
    // a music bed under dialogue is the usual case; effects and voice usually shouldn't dip
    duck: m.params?.kind === 'music' || m.params?.kind === 'song',
  }
}

export function addLanes(items: MediaItem[]) {
  useScoreDraft.setState((s) => ({ lanes: [...s.lanes, ...items.map(laneFrom)].slice(0, MAX_LANES) }))
}

export function patchLane(key: string, patch: Partial<Lane>) {
  useScoreDraft.setState((s) => ({ lanes: s.lanes.map((l) => (l.key === key ? { ...l, ...patch } : l)) }))
}

export function removeLane(key: string) {
  useScoreDraft.setState((s) => ({ lanes: s.lanes.filter((l) => l.key !== key) }))
}

export function setVideo(id: string | null) {
  // a different clip means different timing; keep the chosen tracks but start them at zero
  useScoreDraft.setState((s) => (s.videoId === id ? s : { videoId: id, lanes: s.lanes.map((l) => ({ ...l, offset_s: 0 })) }))
}

export const resetDraft = () => useScoreDraft.setState({ ...EMPTY })

const r3 = (n: number) => Math.round(n * 1000) / 1000

/** The request body. Solo is ours, not the server's: soloing a lane mutes the others. */
export function mixBody(d: ScoreDraft): MixIn | null {
  if (!d.videoId) return null
  const solo = d.lanes.some((l) => l.solo)
  return {
    video_id: d.videoId,
    original: { keep: d.original.keep, gain_db: d.original.gain_db },
    tracks: d.lanes.map((l) => ({
      media_id: l.mediaId,
      offset_s: r3(Math.max(0, l.offset_s)),
      gain_db: l.gain_db,
      mute: l.mute || (solo && !l.solo),
      fade_in_s: l.fade_in_s,
      fade_out_s: l.fade_out_s,
      loop: l.loop,
      duck: l.duck,
    })),
    duck: { amount_db: d.duckDb, under: 'original' },
    ...(d.loudness ? { loudness: { target: d.loudness } } : {}),
  }
}
