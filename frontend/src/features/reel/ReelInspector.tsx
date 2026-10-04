import { useRef } from 'react'
import { Link } from 'react-router'
import { Clapperboard, MousePointerClick, Sparkle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { EmptyState, ErrorState } from '@/components/studio/states'
import { useReel, useUpdateClip } from '@/hooks/useReel'
import { useProjectAspectClass } from '@/lib/aspect'
import { formatTimecode } from '@/lib/duration'
import { findClip, outPoint } from '@/lib/reel'
import type { ReelClipPatch } from '@/lib/types'
import { cn } from '@/lib/utils'
import { useWorkspace } from '@/stores/workspace'
import { TransitionFields } from './TransitionChip'
import { TrimControls } from './TrimControls'
import { useShotIndex } from './useShotIndex'

export function ReelInspector() {
  const shots = useShotIndex()
  const { projectId } = shots
  const reel = useReel(projectId)
  const clipId = useWorkspace((s) => s.selectedClip[projectId])
  const update = useUpdateClip(projectId)
  const aspect = useProjectAspectClass()
  const video = useRef<HTMLVideoElement>(null)
  const clip = findClip(reel.data, clipId)

  if (!clip) {
    return (
      <EmptyState icon={<MousePointerClick />} title="No clip selected">
        Pick a clip on the Reel to trim it, change its transition or leave it out.
      </EmptyState>
    )
  }

  const found = shots.shotFor(clip.shot_id)
  const label = found?.label ?? '?'
  const out = outPoint(clip)
  const save = (patch: ReelClipPatch) => update.mutate({ id: clip.id, patch })

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="min-w-0 flex-1 truncate text-heading font-semibold">
          Clip {label} · <span className="font-mono">{formatTimecode(clip.duration_s)}</span>
        </h2>
        {clip.changed && (
          <span className="inline-flex items-center gap-1 text-small text-studio-warning">
            <Sparkle aria-hidden className="size-3" />
            New take since last assemble
          </span>
        )}
      </div>
      {found?.shot.description && <p className="-mt-2 text-small text-studio-muted">{found.shot.description}</p>}

      <figure className={cn('darkroom w-full overflow-hidden rounded-[6px]', aspect)}>
        <video
          key={clip.id}
          ref={video}
          src={clip.media_url}
          controls
          muted
          playsInline
          preload="metadata"
          aria-label={`Clip ${label} preview`}
          className="size-full object-contain"
          onLoadedMetadata={(e) => (e.currentTarget.currentTime = clip.trim_in_s)}
          // loop inside the trim so the cut can be judged
          onTimeUpdate={(e) => {
            const v = e.currentTarget
            if (!v.paused && v.currentTime >= out) v.currentTime = clip.trim_in_s
          }}
        />
      </figure>

      <TrimControls key={clip.id} clip={clip} playhead={() => video.current?.currentTime ?? null} onSave={save} />

      <div className="flex items-center justify-between gap-3">
        <label htmlFor="clip-enabled" className="text-body">
          Use in the film
          <span className="block text-small text-studio-muted">
            {clip.enabled ? 'Included when the film is assembled.' : 'Left out; the scene plays without it.'}
          </span>
        </label>
        <Switch id="clip-enabled" checked={clip.enabled} onCheckedChange={(v) => save({ enabled: v })} />
      </div>

      <TransitionFields key={`t-${clip.id}`} clip={clip} onChange={save} />

      {update.isError && <ErrorState compact title="That change didn't save" error={update.error} />}

      {found && (
        <Button asChild variant="secondary" className="self-start">
          <Link to={`/projects/${projectId}/render`} onClick={() => shots.openInRender(found.shot)}>
            <Clapperboard aria-hidden />
            Open in Render
          </Link>
        </Button>
      )}
    </div>
  )
}
