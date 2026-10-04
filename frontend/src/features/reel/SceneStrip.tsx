import { Badge } from '@/components/ui/badge'
import { StatusPill } from '@/components/studio/status-pill'
import { formatTimecode } from '@/lib/duration'
import { mezzanineStatus } from '@/lib/status'
import { cn } from '@/lib/utils'
import type { ReelClip, ReelClipPatch, ReelScene } from '@/lib/types'
import { ClipCard } from './ClipCard'
import { TransitionChip } from './TransitionChip'

export interface ClipMeta {
  label: string
  description?: string
}

interface Props {
  scene: ReelScene
  index: number
  isFirstScene: boolean
  // inside the Stitch panel's current selection
  inStitch?: boolean
  meta: (clip: ReelClip) => ClipMeta
  selectedClipId: string | undefined
  moving: boolean
  onSelect: (clip: ReelClip) => void
  onMove: (clip: ReelClip, dir: -1 | 1) => void
  onPatch: (clip: ReelClip, patch: ReelClipPatch) => void
}

export function SceneStrip({ scene, index, isFirstScene, inStitch, meta, selectedClipId, moving, onSelect, onMove, onPatch }: Props) {
  const changed = scene.clips.filter((c) => c.changed).map((c) => meta(c).label)
  return (
    <section
      aria-labelledby={`reel-scene-${scene.scene_id}`}
      className={cn(
        'rounded-[6px] border bg-studio-panel p-3 shadow-card transition-colors',
        inStitch ? 'border-studio-accent ring-1 ring-studio-gold/50' : 'border-studio-border-strong',
      )}
    >
      <header className="mb-2 flex flex-wrap items-center gap-2">
        <span className="rounded-[4px] bg-studio-accent-soft px-1.5 font-mono text-small font-medium text-studio-accent-hover">
          Sc {index + 1}
        </span>
        <h2 id={`reel-scene-${scene.scene_id}`} className="min-w-0 flex-1 truncate font-display text-panel font-semibold">
          {scene.heading || 'Untitled scene'}
        </h2>
        {inStitch && <Badge tone="accent">In stitch</Badge>}
        <span className="font-mono text-small text-studio-muted">{formatTimecode(scene.duration_s)}</span>
        <StatusPill status={mezzanineStatus(scene.mezzanine.status)} />
      </header>
      {scene.mezzanine.status === 'stale' && changed.length > 0 && (
        <p className="mb-2 text-small text-studio-muted">Changed since the last assemble: shot {changed.join(', ')}.</p>
      )}
      {scene.clips.length === 0 ? (
        <p className="text-small text-studio-muted">No approved takes in this scene yet.</p>
      ) : (
        <ol aria-label={`Clips in scene ${index + 1}`} className="flex items-start gap-1.5 overflow-x-auto pb-1">
          {scene.clips.map((clip, i) => {
            const m = meta(clip)
            return (
              <li key={clip.id} className="flex items-start gap-1.5">
                {/* the first clip's transition is the join from the previous scene */}
                {(i > 0 || !isFirstScene) && (
                  <span className="flex flex-col items-center pt-4">
                    <TransitionChip clip={clip} label={`clip ${m.label}`} onChange={(p) => onPatch(clip, p)} />
                    {i === 0 && <span className="mt-0.5 text-[11px] text-studio-muted">from Sc {index}</span>}
                  </span>
                )}
                <ClipCard
                  clip={clip}
                  label={m.label}
                  description={m.description}
                  selected={selectedClipId === clip.id}
                  first={i === 0}
                  last={i === scene.clips.length - 1}
                  moving={moving}
                  onSelect={() => onSelect(clip)}
                  onMove={(dir) => onMove(clip, dir)}
                />
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}
