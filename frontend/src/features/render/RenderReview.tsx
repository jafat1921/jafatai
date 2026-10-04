import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState, ErrorState } from '@/components/studio/states'
import { useGenerations } from '@/hooks/useGenerations'
import { useProjectAspectClass } from '@/lib/aspect'
import { shotLabel } from '@/lib/shots'
import type { Shot } from '@/lib/types'
import { cn } from '@/lib/utils'
import { QuickReview } from '@/features/storyboard/StoryboardReview'
import { useStoryboard } from '@/features/storyboard/useStoryboard'
import { takesInOrder } from './takes'

function ShotTakes({ shot, label, aspect }: { shot: Shot; label: string; aspect: string }) {
  const takes = useGenerations({ targetType: 'shot', targetId: shot.id, kind: 'take' }, false)
  const list = takesInOrder(takes.data)
  if (takes.isPending) return <Skeleton className="h-24" />
  if (!list.length) return null
  return (
    <article aria-label={`Shot ${label}`} className="rounded-[6px] border border-studio-border bg-studio-panel p-2.5">
      <p className="mb-2 text-small">
        <span className="font-mono text-studio-muted">{label}</span> {shot.description}
      </p>
      <ol className="flex flex-col gap-3">
        {list.map((t, i) => (
          <li key={t.id} className="flex flex-col gap-1.5">
            <div className={cn('darkroom overflow-hidden rounded-[6px]', aspect)}>
              {t.media_url && (
                // controls give play / unmute on touch; starts muted like the desktop take row
                <video src={t.media_url} controls muted playsInline preload="metadata" className="size-full object-contain" aria-label={`Take ${i + 1} of shot ${label}`} />
              )}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-small text-studio-muted">Take {i + 1}</span>
              <div className="flex-1">
                <QuickReview gen={t} subject={`Take ${i + 1} of shot ${label}`} />
              </div>
            </div>
          </li>
        ))}
      </ol>
    </article>
  )
}

export function RenderReview() {
  const { scenes, shots, groups } = useStoryboard()
  const aspect = useProjectAspectClass()
  if (scenes.isPending || shots.isPending) return <Skeleton className="h-40" />
  const error = scenes.error ?? shots.error
  if (error) return <ErrorState error={error} onRetry={() => shots.refetch()} />
  const withTakes = groups.filter((g) => g.shots.some((s) => s.takes_count > 0))
  if (!withTakes.length) return <EmptyState title="No takes yet">Rendered takes show up here to watch and approve.</EmptyState>
  return (
    <ol className="flex flex-col gap-4">
      {withTakes.map((g) => (
        <li key={g.scene.id} className="flex flex-col gap-2">
          <h2 className="font-display text-panel font-semibold">
            {g.index + 1}. {g.scene.heading || 'Untitled scene'}
          </h2>
          {g.shots.map((s, i) => (s.takes_count > 0 ? <ShotTakes key={s.id} shot={s} label={shotLabel(g.index, i)} aspect={aspect} /> : null))}
        </li>
      ))}
    </ol>
  )
}
