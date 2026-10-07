import { useModels, useUpdateProjectSettings } from '@/hooks/useModels'
import { useProject } from '@/hooks/useProjects'
import { VIDEO_HQ, VIDEO_STANDARD } from '@/lib/models'
import type { ModelInfo } from '@/lib/types'

export type RenderQuality = 'standard' | 'hq'

export const HQ_LONG_TAKE_REASON = 'High quality renders single-chunk shots only, so long takes use Standard.'
export const SMOOTH_LONG_TAKE_REASON = 'Smooth motion works on single-chunk shots only, so it is skipped for long takes.'

export function smoothState(m: ModelInfo | undefined) {
  if (!m?.smooth_motion) return null
  return { available: m.smooth_motion.available, reason: m.smooth_motion.reason ?? null }
}

/**
 * Render quality and smooth motion are project settings (video_quality, smooth_motion), so every take,
 * scene render and Quick batch picks them up; the server falls back to Standard for long takes.
 */
export function useRenderOptions(projectId: string) {
  const { models } = useModels('video')
  const project = useProject(projectId || undefined)
  const save = useUpdateProjectSettings(projectId)
  const settings = project.data?.settings ?? {}
  const standard = models.find((m) => m.id === VIDEO_STANDARD)
  const hq = models.find((m) => m.id === VIDEO_HQ)
  const quality: RenderQuality = settings.video_quality === 'hq' && hq?.available ? 'hq' : 'standard'
  const smooth = smoothState(quality === 'hq' ? hq : standard)

  return {
    hq,
    quality,
    setQuality: (q: RenderQuality) => save.mutate({ video_quality: q }),
    smooth,
    smoothOn: !!settings.smooth_motion && !!smooth?.available,
    setSmooth: (on: boolean) => save.mutate({ smooth_motion: on }),
    error: save.error,
  }
}
