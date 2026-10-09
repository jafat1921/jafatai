import { rangeText } from './estimate'
import { isQuickJob } from './quick'
import type { Job } from './types'

/**
 * Time left for a job: the server's own eta_s when it sends one, else extrapolated from progress
 * and time running (only once there's enough progress to mean anything).
 */
export function etaSeconds(job: Job, now = Date.now()): number | null {
  const eta = (job.result as { eta_s?: unknown } | null | undefined)?.eta_s
  if (typeof eta === 'number' && Number.isFinite(eta)) return Math.max(0, eta)
  if (job.status !== 'running' || !job.started_at || job.progress < 0.05 || job.progress >= 1) return null
  const elapsed = (now - new Date(job.started_at).getTime()) / 1000
  if (!(elapsed > 0)) return null
  return (elapsed * (1 - job.progress)) / job.progress
}

export function etaText(job: Job, now = Date.now()) {
  const s = etaSeconds(job, now)
  if (s == null) return job.status === 'queued' ? 'Waiting' : 'Working out the time…'
  if (s < 5) return 'Almost done'
  // a single extrapolation is shaky; show it as a range so it doesn't promise too much
  return `${rangeText(s * 0.85, s * 1.25)} left`
}

/** Where "Open" goes for a job when nothing better was recorded when it started. */
export function jobOpenPath(job: Job): string {
  if (job.project_id && isQuickJob(job)) return `/quick/${job.project_id}`
  if (job.project_id) return `/projects/${job.project_id}/render`
  if (job.type === 'photo_render' && job.generation_id) return `/image/studio/${job.generation_id}`
  if (/video|clip|i2v/.test(job.type)) return '/video/library'
  if (/image|edit|img2img|upscale/.test(job.type)) return '/image/library'
  return '/queue'
}
