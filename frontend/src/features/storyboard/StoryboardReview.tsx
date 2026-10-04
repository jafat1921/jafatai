import { Check, ImageIcon, Link2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState, ErrorState } from '@/components/studio/states'
import { StatusPill } from '@/components/studio/status-pill'
import { useGenerationActions } from '@/hooks/useGenerations'
import { useProjectAspectClass } from '@/lib/aspect'
import { shotLabel, startFrameOf } from '@/lib/shots'
import { generationStatus } from '@/lib/status'
import type { Generation } from '@/lib/types'
import { cn } from '@/lib/utils'
import { announce } from '@/stores/ui'
import { useStoryboard } from './useStoryboard'

// Phone-sized approve / reject for one generation. Full review (versions, notes) needs the desktop inspector.
export function QuickReview({ gen, subject }: { gen: Generation; subject: string }) {
  const { approve, reject } = useGenerationActions()
  const busy = approve.isPending || reject.isPending
  if (gen.status !== 'ready') return <StatusPill status={generationStatus(gen.status)} />
  return (
    <div className="flex gap-1.5">
      <Button
        size="sm"
        variant="primary"
        disabled={busy}
        className="min-h-11 flex-1 sm:min-h-0"
        onClick={() => approve.mutate(gen.id, { onSuccess: () => announce(`${subject} approved.`) })}
      >
        <Check aria-hidden />
        Approve
      </Button>
      <Button
        size="sm"
        variant="secondary"
        disabled={busy}
        className="min-h-11 sm:min-h-0"
        onClick={() => reject.mutate(gen.id, { onSuccess: () => announce(`${subject} rejected.`) })}
      >
        <X aria-hidden />
        Reject
      </Button>
    </div>
  )
}

function Frame({
  gen,
  side,
  subject,
  linked,
  aspect,
}: {
  gen: Generation | null | undefined
  side: string
  subject: string
  linked?: boolean
  aspect: string
}) {
  return (
    <figure className="flex min-w-0 flex-1 flex-col gap-1.5">
      <div className={cn('darkroom relative overflow-hidden rounded-[6px]', aspect)}>
        {gen?.media_url ? (
          <img src={gen.media_url} alt={subject} className="size-full object-cover" loading="lazy" />
        ) : (
          <span className="flex size-full items-center justify-center text-studio-on-dark-muted">
            <ImageIcon aria-hidden className="size-5" />
          </span>
        )}
      </div>
      <figcaption className="flex flex-col gap-1">
        <span className="inline-flex items-center gap-1 text-small text-studio-muted">
          {side}
          {linked && (
            <>
              <Link2 aria-hidden className="size-3" /> linked
            </>
          )}
        </span>
        {gen && !linked && <QuickReview gen={gen} subject={subject} />}
      </figcaption>
    </figure>
  )
}

export function StoryboardReview() {
  const { scenes, shots, groups, prevOf } = useStoryboard()
  const aspect = useProjectAspectClass()
  if (scenes.isPending || shots.isPending) return <Skeleton className="h-40" />
  const error = scenes.error ?? shots.error
  if (error) return <ErrorState error={error} onRetry={() => shots.refetch()} />
  if (!groups.some((g) => g.shots.length)) {
    return <EmptyState title="No storyboard yet">Storyboard the script on a larger screen; frames show up here to approve.</EmptyState>
  }
  return (
    <ol className="flex flex-col gap-4">
      {groups
        .filter((g) => g.shots.length)
        .map((g) => (
          <li key={g.scene.id} className="flex flex-col gap-2">
            <h2 className="font-display text-panel font-semibold">
              {g.index + 1}. {g.scene.heading || 'Untitled scene'}
            </h2>
            {g.shots.map((s, i) => {
              const label = shotLabel(g.index, i)
              const start = startFrameOf(s, prevOf(s))
              return (
                <article key={s.id} aria-label={`Shot ${label}`} className="rounded-[6px] border border-studio-border bg-studio-panel p-2.5">
                  <p className="mb-2 text-small">
                    <span className="font-mono text-studio-muted">{label}</span> {s.description}
                  </p>
                  <div className="flex gap-2">
                    <Frame gen={start.frame} side="START" subject={`START of shot ${label}`} linked={start.linked} aspect={aspect} />
                    <Frame gen={s.end_frame} side="END" subject={`END of shot ${label}`} aspect={aspect} />
                  </div>
                </article>
              )
            })}
          </li>
        ))}
    </ol>
  )
}
