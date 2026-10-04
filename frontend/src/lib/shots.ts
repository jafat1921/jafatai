import type { Generation, Scene, Shot, ShotType, StoryboardRequest } from './types'

export const SHOT_TYPES: { value: ShotType; label: string; disabled?: boolean }[] = [
  { value: 'establishing', label: 'Establishing' },
  { value: 'wide', label: 'Wide' },
  { value: 'medium', label: 'Medium' },
  { value: 'close_up', label: 'Close-up' },
  { value: 'extreme_close_up', label: 'Extreme close-up' },
  { value: 'over_shoulder', label: 'Over the shoulder' },
  { value: 'pov', label: 'POV' },
  { value: 'insert', label: 'Insert' },
  // PLAN §7.1 long-take editor isn't built yet
  { value: 'long_take', label: 'Long take (coming)', disabled: true },
]

export const shotLabel = (sceneIndex: number, shotIndex: number) => `${sceneIndex + 1}.${shotIndex + 1}`

export const shotTypeLabel = (t: ShotType) => SHOT_TYPES.find((x) => x.value === t)?.label ?? t

export interface SceneShots {
  scene: Scene
  index: number
  shots: Shot[]
}

const byOrder = (a: { order: number }, b: { order: number }) => a.order - b.order

// Scenes can be reordered client-side before the shot list refetches, so group by scene order here.
export function groupShots(scenes: Scene[], shots: Shot[]): SceneShots[] {
  const bySceneId = new Map<string, Shot[]>()
  for (const s of shots) {
    const list = bySceneId.get(s.scene_id)
    if (list) list.push(s)
    else bySceneId.set(s.scene_id, [s])
  }
  return [...scenes].sort(byOrder).map((scene, index) => ({
    scene,
    index,
    shots: (bySceneId.get(scene.id) ?? []).sort(byOrder),
  }))
}

export const flatten = (groups: SceneShots[]) => groups.flatMap((g) => g.shots)

export interface StartFrame {
  frame: Generation | null | undefined
  linked: boolean
  // the shot whose END frame this START is
  from?: Shot
}

// Continue seam: START *is* the previous shot's END (contract v1). Our cached copy of the previous
// shot is live via SSE, so prefer it over the server's denormalised start_frame.
export function startFrameOf(shot: Shot, prev: Shot | undefined): StartFrame {
  if (shot.seam_in === 'continue') {
    return { frame: prev?.end_frame ?? (shot.start_linked ? shot.start_frame : null), linked: true, from: prev }
  }
  return { frame: shot.start_frame, linked: false }
}

export const isApproved = (g: Generation | null | undefined) => g?.status === 'approved'

/** A take needs an approved (or linked-and-approved) START; END is optional (I2V from START only). */
export function canRender(shot: Shot, prev: Shot | undefined) {
  return isApproved(startFrameOf(shot, prev).frame)
}

// "≈ 30 s per 5 s take when warm" — from the LTX benchmark, rounded.
export const SECONDS_PER_TAKE_SECOND = 6
export const MODEL_LOAD_S: [number, number] = [60, 120]

export function estimateRenderSeconds(shots: Shot[], count: number) {
  return shots.reduce((sum, s) => sum + Math.max(1, s.duration_s) * SECONDS_PER_TAKE_SECOND * count, 0)
}

export function formatEstimate(seconds: number) {
  if (seconds < 90) return `${Math.max(1, Math.round(seconds / 10) * 10)} s`
  const m = Math.round(seconds / 60)
  if (m < 90) return `${m} min`
  return `${Math.floor(m / 60)} h ${m % 60} min`
}

export interface StoryboardForm {
  mode: 'scene' | 'shots'
  chain: boolean
  scope: 'all' | 'selected'
  generateFrames: boolean
  includeExisting: boolean
}

export const DEFAULT_STORYBOARD_FORM: StoryboardForm = {
  mode: 'scene',
  chain: false,
  scope: 'all',
  generateFrames: true,
  includeExisting: false,
}

export function buildStoryboardRequest(form: StoryboardForm, selectedSceneId?: string): StoryboardRequest {
  const body: StoryboardRequest = {
    mode: form.mode,
    generate_frames: form.generateFrames,
    overwrite: form.includeExisting,
  }
  if (form.scope === 'selected' && selectedSceneId) body.scene_ids = [selectedSceneId]
  // contract: `continuity:"chain"`; omitted means cuts between scenes
  if (form.chain) body.continuity = 'chain'
  return body
}

/** A row on the Storyboard canvas: one shot, or (scene view) a whole scene from its first START to last END. */
export interface FrameUnit {
  key: string
  scene: Scene
  sceneIndex: number
  startShot: Shot
  endShot: Shot
  prevShot?: Shot // shot before startShot across the whole film, for Continue seams
  shotIndex?: number
  shotCount: number
}

export function buildUnits(view: 'scenes' | 'shots', groups: SceneShots[], sceneId?: string): FrameUnit[] {
  const all = flatten(groups)
  const prevOf = (s: Shot) => {
    const i = all.indexOf(s)
    return i > 0 ? all[i - 1] : undefined
  }
  if (view === 'scenes') {
    return groups
      .filter((g) => g.shots.length > 0)
      .map((g) => ({
        key: g.scene.id,
        scene: g.scene,
        sceneIndex: g.index,
        startShot: g.shots[0],
        endShot: g.shots[g.shots.length - 1],
        prevShot: prevOf(g.shots[0]),
        shotCount: g.shots.length,
      }))
  }
  const g = groups.find((x) => x.scene.id === sceneId)
  if (!g) return []
  return g.shots.map((s, i) => ({
    key: s.id,
    scene: g.scene,
    sceneIndex: g.index,
    startShot: s,
    endShot: s,
    prevShot: prevOf(s),
    shotIndex: i,
    shotCount: g.shots.length,
  }))
}
