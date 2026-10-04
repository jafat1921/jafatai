import { Clapperboard, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/alert-dialog'
import { Progress } from '@/components/ui/progress'
import { ErrorState } from '@/components/studio/states'
import { ShortcutHelp, type Shortcut } from '@/components/studio/shortcut-help'
import { StatusPill } from '@/components/studio/status-pill'
import { useJobs } from '@/hooks/useJobs'
import { useAssemble, useReelEstimate, useSyncReel } from '@/hooks/useReel'
import { formatTimecode } from '@/lib/duration'
import { clipCount, staleSceneCount } from '@/lib/reel'
import { formatEstimate } from '@/lib/shots'
import { generationStatus, isActiveJob } from '@/lib/status'
import type { Reel } from '@/lib/types'
import { plural, timeAgo } from '@/lib/utils'
import { announce } from '@/stores/ui'

const SHORTCUTS: Shortcut[] = [
  [['I'], 'set the in point of the selected clip at the playhead'],
  [['O'], 'set the out point at the playhead'],
]

export function ReelHeader({
  reel,
  projectId,
  confirming,
  setConfirming,
}: {
  reel: Reel
  projectId: string
  confirming: boolean
  setConfirming: (v: boolean) => void
}) {
  const sync = useSyncReel(projectId)
  const assemble = useAssemble(projectId)
  const estimate = useReelEstimate(projectId, confirming)
  const { data: jobs } = useJobs()
  const running = jobs?.find((j) => j.project_id === projectId && /assemble|reel|mezzanine/.test(j.type) && isActiveJob(j.status))

  const clips = clipCount(reel)
  const stale = estimate.data?.stale_scenes ?? staleSceneCount(reel)
  const builtScenes = reel.scenes.filter((s) => s.clips.length > 0).length
  const last = reel.last_render

  return (
    <header className="flex flex-col gap-2 px-5 pb-3 pt-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="flex items-center gap-1 text-title font-display font-semibold">
            Reel · <span className="font-mono text-[20px]">{formatTimecode(reel.duration_s)}</span>
            <ShortcutHelp shortcuts={SHORTCUTS} />
          </h1>
          <p className="text-small text-studio-muted">
            {plural(clips, 'clip')} · {stale ? `${plural(stale, 'scene')} to rebuild` : 'all scenes up to date'} ·{' '}
            {last ? (
              <span className="inline-flex items-center gap-1 align-middle">
                last render v{last.version} {timeAgo(last.created_at)}
                <StatusPill status={generationStatus(last.status)} />
              </span>
            ) : (
              'not assembled yet'
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            loading={sync.isPending}
            onClick={() => sync.mutate(undefined, { onSuccess: () => announce('Reel synced with approved takes.') })}
          >
            <RefreshCw aria-hidden />
            Sync with approved takes
          </Button>
          <Button variant="primary" disabled={clips === 0 || !!running} onClick={() => setConfirming(true)} loading={assemble.isPending}>
            <Clapperboard aria-hidden />
            Assemble film (draft)
          </Button>
        </div>
      </div>
      {running && (
        <div role="status" className="flex flex-col gap-1">
          <span className="text-small text-studio-muted">{running.message || 'Assembling the film…'}</span>
          <Progress value={running.status === 'running' ? running.progress : null} label="Assembly progress" />
        </div>
      )}
      {sync.isError && <ErrorState compact title="Couldn't sync the reel" error={sync.error} />}
      {assemble.isError && <ErrorState compact title="Couldn't start assembly" error={assemble.error} />}

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Assemble a draft of the film?"
        description={
          <>
            {formatTimecode(estimate.data?.duration_s ?? reel.duration_s)} from {plural(estimate.data?.clips ?? clips, 'clip')}.{' '}
            {stale
              ? `${plural(stale, 'scene')} of ${builtScenes} changed and will be rebuilt; the rest are reused.`
              : 'Every scene is up to date, so only the final join runs.'}
            {estimate.data ? ` About ${formatEstimate(estimate.data.est_seconds)}.` : ' Usually a few minutes.'}
          </>
        }
        confirmLabel="Assemble draft"
        onConfirm={() => assemble.mutate(undefined, { onSuccess: () => announce('Assembly queued.') })}
      />
    </header>
  )
}
