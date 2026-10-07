import { useState } from 'react'
import { Link } from 'react-router'
import { LayoutGrid, ListChecks, ListTree, Rows3, ScrollText, Wand2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { EmptyState, ErrorState } from '@/components/studio/states'
import { ShortcutHelp, type Shortcut } from '@/components/studio/shortcut-help'
import { useAiJob, useLatestJob } from '@/hooks/useAi'
import { useStageShortcuts } from '@/hooks/useStageShortcuts'
import { useUpdateShot } from '@/hooks/useShots'
import { api } from '@/lib/api'
import type { StoryboardRequest } from '@/lib/types'
import { plural } from '@/lib/utils'
import { announce } from '@/stores/ui'
import { StoryboardDialog } from './StoryboardDialog'
import { StoryboardJobBanner } from './StoryboardJobBanner'
import { StoryboardList } from './StoryboardList'
import { useStoryboard } from './useStoryboard'

const SHORTCUTS: Shortcut[] = [
  [['J', 'K'], 'previous / next shot'],
  [['[', ']'], 'select START / END'],
  [['L'], 'toggle Cut / Continue seam'],
]

export function StoryboardCanvas() {
  const board = useStoryboard()
  const { projectId, scenes, shots, scene, groups, all } = board
  const [dialog, setDialog] = useState<{ scope: 'all' | 'selected' } | null>(null)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const storyboard = useAiJob((body: StoryboardRequest) => api.storyboard.fromScript(projectId, body))
  // the job outlives this canvas (switching stages unmounts it), so fall back to the latest one
  const latestA = useLatestJob(projectId, 'storyboard')
  const latestB = useLatestJob(projectId, 'ai_storyboard')
  const latest = latestA ?? latestB
  const job = storyboard.job ?? (latest && (latest.status === 'queued' || latest.status === 'running') ? latest : undefined)
  const updateShot = useUpdateShot(projectId)

  const { selectedUnit, selection } = board
  useStageShortcuts({
    j: () => board.step(-1),
    k: () => board.step(1),
    '[': () => {
      const u = selectedUnit ?? board.units[0]
      if (u) board.selectFrame(u.startShot, 'start', false)
    },
    ']': () => {
      const u = selectedUnit ?? board.units[0]
      if (u) board.selectFrame(u.endShot, 'end', false)
    },
    l: () => {
      const shot = selectedUnit?.startShot
      if (!shot || !selectedUnit?.prevShot) return
      const seam_in = shot.seam_in === 'continue' ? 'cut' : 'continue'
      updateShot.mutate({ id: shot.id, patch: { seam_in } })
      announce(seam_in === 'continue' ? 'Seam set to Continue: START is linked to the previous END.' : 'Seam set to Cut.')
    },
  })

  const scenesWithShots = groups.filter((g) => g.shots.length > 0).length
  const pending = groups.filter((g) => g.scene.shots_review === 'pending' && g.shots.length > 0).map((g) => g.scene)
  const openDialog = (scope: 'all' | 'selected', sceneId?: string) => {
    if (sceneId && sceneId !== scene?.id) board.selectScene(sceneId)
    setDialog({ scope })
  }

  if (scenes.isPending || shots.isPending) {
    return (
      <div className="flex flex-col gap-3 p-5" role="status" aria-label="Loading storyboard">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-48" />
        <Skeleton className="h-48" />
      </div>
    )
  }
  const loadError = scenes.error ?? shots.error
  if (loadError) {
    return (
      <div className="mx-auto max-w-lg p-8">
        <ErrorState title="Couldn't load the storyboard" error={loadError} onRetry={() => (scenes.refetch(), shots.refetch())} />
      </div>
    )
  }

  const empty = all.length === 0
  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-start justify-between gap-3 px-5 pb-3 pt-4">
        <div className="min-w-0">
          <h1 className="flex items-center gap-1 text-title font-display font-semibold">
            Storyboard
            <ShortcutHelp shortcuts={SHORTCUTS} />
          </h1>
          <p className="text-small text-studio-muted">
            {plural(all.length, 'shot')} across {plural(scenesWithShots, 'scene')} · approve START and END frames before rendering
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!!scenes.data?.length && (
            <ToggleGroup
              type="single"
              value={board.view}
              onValueChange={(v) => v && board.setView(v as 'scenes' | 'shots')}
              aria-label="Storyboard view"
            >
              <ToggleGroupItem value="scenes">
                <Rows3 aria-hidden />
                Scenes
              </ToggleGroupItem>
              <ToggleGroupItem value="shots">
                <ListTree aria-hidden />
                Shots
              </ToggleGroupItem>
            </ToggleGroup>
          )}
          <Button variant="primary" onClick={() => openDialog('all')} disabled={!scenes.data?.length || storyboard.working}>
            <Wand2 aria-hidden />
            Storyboard from script
          </Button>
        </div>
      </header>

      <StoryboardJobBanner
        job={job && job.id !== dismissed ? job : undefined}
        error={storyboard.error}
        onDismiss={() => setDismissed(job?.id ?? null)}
      />

      {pending.length > 0 && !(board.view === 'shots' && scene?.shots_review === 'pending') && (
        <div role="status" className="mx-5 mb-3 flex flex-wrap items-center gap-2 rounded-[6px] border border-studio-accent bg-studio-accent-soft px-3 py-2">
          <ListChecks aria-hidden className="size-4 text-studio-accent-hover" />
          <span className="flex-1 text-body">
            {plural(pending.length, 'scene')} {pending.length === 1 ? 'has' : 'have'} a shot list waiting for review. No frames are
            drawn until you approve.
          </span>
          <Button
            size="sm"
            variant="primary"
            onClick={() => {
              board.selectScene(pending[0].id)
              board.setView('shots')
            }}
          >
            Review {pending.length > 1 ? 'the first' : 'it'}
          </Button>
        </div>
      )}

      <ScrollArea className="min-h-0 flex-1">
        <div className="px-5 pb-8">
          {!scenes.data?.length ? (
            <EmptyState
              icon={<ScrollText />}
              title="Write the script first"
              action={
                <Button asChild variant="primary">
                  <Link to={`/projects/${projectId}/script`}>Go to Script</Link>
                </Button>
              }
            >
              The storyboard is drawn from your scenes: a first and last frame for each one.
            </EmptyState>
          ) : empty && board.view === 'scenes' ? (
            <EmptyState
              icon={<LayoutGrid />}
              title="Storyboard your film from the script"
              action={
                <>
                  <Button variant="primary" size="lg" onClick={() => openDialog('all')} disabled={storyboard.working}>
                    <Wand2 aria-hidden />
                    Storyboard from script
                  </Button>
                  <Button variant="secondary" size="lg" onClick={() => board.setView('shots')}>
                    <ListTree aria-hidden />
                    Break a scene into shots
                  </Button>
                </>
              }
            >
              One click: the AI gives every scene a first and last frame built from your cast and locations. You can break
              scenes into shots afterwards.
            </EmptyState>
          ) : (
            <StoryboardList board={board} onStoryboardScene={(id) => openDialog('selected', id)} />
          )}
          {selection && !board.selectedShot && <span className="sr-only">The selected shot no longer exists.</span>}
        </div>
      </ScrollArea>

      <StoryboardDialog
        open={dialog !== null}
        onOpenChange={(o) => !o && setDialog(null)}
        initialScope={dialog?.scope}
        selectedSceneId={scene?.id}
        selectedSceneLabel={scene ? scene.heading || 'Untitled scene' : undefined}
        scenesWithShots={scenesWithShots}
        pending={storyboard.working && !storyboard.job}
        onSubmit={(body) => {
          setDialog(null)
          setDismissed(null)
          storyboard.run(body)
          announce(
            body.review_first
              ? 'Storyboard started. The shot list opens for review when it is planned; no frames until you approve.'
              : 'Storyboard started. Frames fill in as they render.',
          )
        }}
      />
    </div>
  )
}
