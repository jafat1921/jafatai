import { Eye, User } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { GenerationViewer } from '@/components/review/GenerationViewer'
import { SourceBadge } from '@/components/studio/source-badge'
import { EmptyState, ErrorState } from '@/components/studio/states'
import { PlaceholderCanvas } from '@/features/stages/PlaceholderCanvas'
import { StoryboardReview } from '@/features/storyboard/StoryboardReview'
import { RenderReview } from '@/features/render/RenderReview'
import type { StageId } from '@/lib/stages'
import { useSelectedCharacter, useSelectedScene } from './selection'

function ScriptReview() {
  const { scenes } = useSelectedScene()
  if (scenes.isPending) return <Skeleton className="h-40" />
  if (scenes.isError) return <ErrorState error={scenes.error} onRetry={() => scenes.refetch()} />
  if (!scenes.data.length) return <EmptyState title="No scenes yet">Scenes written on a larger screen show up here.</EmptyState>
  return (
    <ol className="flex flex-col gap-3">
      {scenes.data.map((s, i) => (
        <li key={s.id} className="rounded-[6px] border border-studio-border bg-studio-panel p-3">
          <div className="flex items-center gap-2">
            <span className="font-mono text-small text-studio-muted">{i + 1}</span>
            <h2 className="min-w-0 flex-1 truncate font-display text-panel font-semibold">{s.heading || 'Untitled scene'}</h2>
            <SourceBadge source={s.source} locked={s.locked} />
          </div>
          {s.logline && <p className="mt-1 text-body text-studio-muted">{s.logline}</p>}
          {s.script_text && (
            <pre className="mt-2 whitespace-pre-wrap break-words font-script text-[13px] text-studio-text">{s.script_text}</pre>
          )}
        </li>
      ))}
    </ol>
  )
}

function CastReview() {
  const { characters } = useSelectedCharacter()
  if (characters.isPending) return <Skeleton className="h-40" />
  if (characters.isError) return <ErrorState error={characters.error} onRetry={() => characters.refetch()} />
  if (!characters.data.length) return <EmptyState icon={<User />} title="No characters yet" />
  return (
    <ul className="flex flex-col gap-4">
      {characters.data.map((c) => (
        <li key={c.id} className="rounded-[6px] border border-studio-border bg-studio-panel p-3">
          <h2 className="mb-2 font-display text-panel font-semibold">{c.name}</h2>
          {/* several viewers on one page, so single-key shortcuts stay off here */}
          <GenerationViewer
            target={{ targetType: 'character', targetId: c.id, kind: 'portrait' }}
            subject={`Portrait of ${c.name}`}
            shortcuts={false}
          />
        </li>
      ))}
    </ul>
  )
}

// <768 px: review only — read the script, approve or reject generations. Editing needs a wider screen.
export function ReviewWorkspace({ stage }: { stage: StageId }) {
  return (
    <main data-f6-region tabIndex={-1} aria-label="Review" className="h-full overflow-y-auto focus-visible:outline-none">
      <p className="flex items-center gap-2 border-b border-studio-border bg-studio-panel px-4 py-2 text-small text-studio-muted">
        <Eye aria-hidden className="size-3.5 shrink-0" />
        Review mode. Editing needs a screen at least 768 px wide.
      </p>
      <div className="p-4">
        {stage === 'script' && <ScriptReview />}
        {stage === 'cast' && <CastReview />}
        {stage === 'storyboard' && <StoryboardReview />}
        {stage === 'render' && <RenderReview />}
        {(stage === 'reel' || stage === 'output') && <PlaceholderCanvas stage={stage} />}
      </div>
    </main>
  )
}
