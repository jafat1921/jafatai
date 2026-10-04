import type { Reel, ReelClip, ReelClipPatch, TransitionKind } from './types'

export const TRANSITIONS: { value: TransitionKind; label: string; short: string }[] = [
  { value: 'cut', label: 'Cut', short: 'Cut' },
  { value: 'dissolve', label: 'Dissolve', short: 'Dissolve' },
  { value: 'fade_black', label: 'Fade through black', short: 'Fade' },
]

// contract-v3 clamps dissolves to this range on the server; we keep the field honest
export const TRANSITION_MIN_S = 0.05
export const TRANSITION_MAX_S = 2
// the reel backend refuses anything shorter
export const MIN_CLIP_S = 0.25

export const transitionLabel = (clip: Pick<ReelClip, 'transition_in' | 'transition_s'>) => {
  const t = TRANSITIONS.find((x) => x.value === clip.transition_in) ?? TRANSITIONS[0]
  return t.value === 'cut' ? t.short : `${t.short} ${round1(clip.transition_s)} s`
}

const round1 = (n: number) => Math.round(n * 10) / 10

// trim_out_s is how much is cut off the END (0 = play to the end), matching the reel backend.
// The UI talks in out points, so convert at the edges.
export const outPoint = (clip: Pick<ReelClip, 'trim_out_s' | 'source_duration_s'>) =>
  Math.max(0, clip.source_duration_s - clip.trim_out_s)

export function trimError(inS: number, outS: number, sourceS: number): string | null {
  if (!Number.isFinite(inS) || !Number.isFinite(outS)) return 'Enter the in and out points in seconds.'
  if (inS < 0) return "The in point can't be before 0 s."
  if (outS > sourceS + 0.01) return `The out point is past the end of the clip (${round1(sourceS)} s).`
  if (inS >= outS) return 'The in point must be before the out point.'
  if (outS - inS < MIN_CLIP_S) return `Keep at least ${MIN_CLIP_S} s of the clip.`
  return null
}

export function trimPatch(inS: number, outS: number, sourceS: number): ReelClipPatch {
  return { trim_in_s: round1(inS), trim_out_s: outS >= sourceS - 0.01 ? 0 : round1(sourceS - outS) }
}

export function applyClipPatch(clip: ReelClip, patch: ReelClipPatch): ReelClip {
  const next = { ...clip, ...patch }
  return { ...next, duration_s: Math.max(0, outPoint(next) - next.trim_in_s) }
}

export function patchReelClip(reel: Reel, clipId: string, update: (c: ReelClip) => ReelClip): Reel {
  const scenes = reel.scenes.map((s) => {
    if (!s.clips.some((c) => c.id === clipId)) return s
    const clips = s.clips.map((c) => (c.id === clipId ? update(c) : c))
    return { ...s, clips, duration_s: sumDuration(clips) }
  })
  return { ...reel, scenes, duration_s: scenes.reduce((t, s) => t + s.duration_s, 0) }
}

const sumDuration = (clips: ReelClip[]) => clips.reduce((t, c) => t + (c.enabled ? c.duration_s : 0), 0)

export const allClips = (reel: Reel) => [...reel.scenes].sort((a, b) => a.order - b.order).flatMap((s) => s.clips)

export const findClip = (reel: Reel | undefined, id: string | undefined) =>
  reel && id ? allClips(reel).find((c) => c.id === id) : undefined

/** Swaps a clip with its neighbour inside its scene; returns null at the ends. Clips never leave their scene. */
export function moveClip(reel: Reel, clipId: string, dir: -1 | 1): { reel: Reel; ids: string[] } | null {
  const scene = reel.scenes.find((s) => s.clips.some((c) => c.id === clipId))
  if (!scene) return null
  const i = scene.clips.findIndex((c) => c.id === clipId)
  const j = i + dir
  if (j < 0 || j >= scene.clips.length) return null
  const clips = scene.clips.slice()
  ;[clips[i], clips[j]] = [clips[j], clips[i]]
  const renumbered = clips.map((c, k) => ({ ...c, order: k }))
  const next = { ...reel, scenes: reel.scenes.map((s) => (s === scene ? { ...s, clips: renumbered } : s)) }
  return { reel: next, ids: allClips(next).map((c) => c.id) }
}

export const clipCount = (reel: Reel) => allClips(reel).filter((c) => c.enabled).length

export const staleSceneCount = (reel: Reel) =>
  reel.scenes.filter((s) => s.clips.length > 0 && s.mezzanine.status !== 'fresh').length

/** The last assembled film still matches the edit: every scene's mezzanine is fresh and the file is there. */
export function renderIsFresh(reel: Reel) {
  const r = reel.last_render
  if (!r?.media_url || (r.status !== 'ready' && r.status !== 'approved')) return false
  return staleSceneCount(reel) === 0
}

export interface PlayItem {
  clip: ReelClip
  in: number
  out: number
}

export const playlist = (reel: Reel): PlayItem[] =>
  allClips(reel)
    .filter((c) => c.enabled && c.media_url)
    .map((clip) => ({ clip, in: clip.trim_in_s, out: outPoint(clip) }))

// Thumbnails grow with clip length but stay readable for 1 s inserts and don't swallow the strip for long takes.
export const clipWidth = (seconds: number) => Math.round(Math.min(320, Math.max(84, seconds * 9)))
