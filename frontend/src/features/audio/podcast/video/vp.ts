import type { Generation, QuickStage, QuickStageKey, VideoPodcast, VPAngle, VPAspect, VPSetPreset, VPShot, VPShotType, VPStageKey } from '@/lib/types'

// the server refuses anything that isn't word for word this (contract-v24)
export const LIKENESS_STATEMENT = "I have the right to use this person's likeness, and they agreed to it being animated."

export type VPStepId = 'hosts' | 'set' | 'look' | 'shots' | 'render' | 'result'
export type VPStepState = 'done' | 'todo' | 'busy' | 'review'

export const VP_STEPS: { id: VPStepId; label: string; stage: VPStageKey }[] = [
  { id: 'hosts', label: 'Hosts', stage: 'cast' },
  { id: 'set', label: 'Set', stage: 'set' },
  { id: 'look', label: 'Look', stage: 'keyframes' },
  { id: 'shots', label: 'Shots', stage: 'plan' },
  { id: 'render', label: 'Render', stage: 'render' },
  { id: 'result', label: 'Result', stage: 'assemble' },
]

export const SET_PRESETS: { value: VPSetPreset; label: string }[] = [
  { value: 'modern_studio', label: 'Modern studio' },
  { value: 'cosy_room', label: 'Cosy room' },
  { value: 'news_desk', label: 'News desk' },
  { value: 'rooftop', label: 'Rooftop' },
  { value: 'desi_baithak', label: 'Desi baithak' },
]

export const ASPECTS: { value: VPAspect; label: string }[] = [
  { value: '16:9', label: '16:9 (YouTube)' },
  { value: '9:16', label: '9:16 (Shorts, Reels)' },
  { value: '1:1', label: '1:1 (square)' },
]

export const SHOT_TYPES: { value: VPShotType; label: string; swatch: string }[] = [
  { value: 'lipsync', label: 'Close-up (speaking)', swatch: 'bg-studio-accent' },
  { value: 'medium', label: 'Two-shot (speaking)', swatch: 'bg-studio-accent/50' },
  { value: 'reaction', label: 'Reaction', swatch: 'bg-studio-success/70' },
  { value: 'wide', label: 'Wide', swatch: 'bg-studio-border-strong' },
  { value: 'cover', label: 'Cover', swatch: 'bg-studio-darkroom' },
]

export const typeOf = (t: VPShotType) => SHOT_TYPES.find((s) => s.value === t) ?? SHOT_TYPES[0]

export const aspectClass = (a: VPAspect | undefined) => (a === '9:16' ? 'aspect-[9/16]' : a === '1:1' ? 'aspect-square' : 'aspect-video')

export const picture = (g: Generation | null | undefined) => g?.thumb_url ?? g?.media_url ?? null

export const generating = (g: Generation | null | undefined) => g?.status === 'queued' || g?.status === 'generating'

/** 65.34 → "01:05.3" */
export function clock(s: number) {
  const t = Math.max(0, Math.round(s * 10) / 10)
  const m = Math.floor(t / 60)
  const sec = (t - m * 60).toFixed(1).padStart(4, '0')
  return `${String(m).padStart(2, '0')}:${sec}`
}

// which angles a shot of this type can use; lip-sync close-ups prefer the speaker's own
export function anglesFor(type: VPShotType, angles: VPAngle[], speakerId: string | null): VPAngle[] {
  if (type === 'cover') return []
  if (type === 'wide' || type === 'medium') return angles.filter((a) => a.key === type)
  if (type === 'reaction') return angles.filter((a) => a.key.endsWith(':listen'))
  const talking = angles.filter((a) => a.key.endsWith(':close') || a.key.endsWith(':three_quarter'))
  const own = talking.filter((a) => a.host_id === speakerId)
  return own.length ? own : talking
}

export function stepStates(vp: VideoPodcast): Record<VPStepId, VPStepState> {
  const by = new Map(vp.stages.map((s) => [s.key, s.status]))
  const out = {} as Record<VPStepId, VPStepState>
  for (const step of VP_STEPS) {
    const st = by.get(step.stage)
    out[step.id] = st === 'running' ? 'busy' : st === 'done' || st === 'skipped' ? 'done' : st === 'review' ? 'review' : 'todo'
  }
  if (vp.outputs.draft || vp.outputs.final) out.result = by.get('assemble') === 'running' ? 'busy' : 'done'
  return out
}

/** The first earlier step that isn't finished: what this step is waiting on, if anything. */
export function blockingStep(vp: VideoPodcast, stepIndex: number): { step: (typeof VP_STEPS)[number]; index: number; status: string } | null {
  const by = new Map(vp.stages.map((s) => [s.key, s.status]))
  for (let i = 0; i < stepIndex; i++) {
    const status = by.get(VP_STEPS[i].stage) ?? 'pending'
    // render and the cut are started from their own steps, so they never hold up the shot plan
    if (VP_STEPS[i].stage === 'render' || VP_STEPS[i].stage === 'assemble') continue
    if (status !== 'done' && status !== 'skipped') return { step: VP_STEPS[i], index: i, status }
  }
  return null
}

export function initialStep(vp: VideoPodcast): number {
  if (vp.review === 'hosts') return 1
  if (vp.review === 'look') return 3
  if (vp.stage === 'done') return 6
  const i = VP_STEPS.findIndex((s) => s.stage === vp.stage)
  return i < 0 ? 1 : i + 1
}

// StageTimeline speaks Quick Create's stages; review isn't one of them, so it reads as waiting with a note
export function timelineStages(vp: VideoPodcast): QuickStage[] {
  return vp.stages.map((s) => ({
    key: s.key as unknown as QuickStageKey,
    label: s.status === 'review' ? `${s.label}: your review` : s.label,
    status: s.status === 'review' ? 'pending' : s.status,
    started_at: s.started_at,
    finished_at: s.finished_at,
    detail: s.detail,
  }))
}

export const speakerName = (vp: VideoPodcast, shot: VPShot) => vp.hosts.find((h) => h.host_id === shot.speaker_id)?.name ?? (shot.type === 'cover' ? 'Cover' : 'Music')
