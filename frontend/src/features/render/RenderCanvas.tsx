import { useState } from 'react'
import { Link } from 'react-router'
import { Clapperboard, LayoutGrid, Volume2, VolumeX } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/alert-dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState, ErrorState } from '@/components/studio/states'
import { ShortcutHelp, type Shortcut } from '@/components/studio/shortcut-help'
import { useGenerations } from '@/hooks/useGenerations'
import { useProject } from '@/hooks/useProjects'
import { useRenderScene } from '@/hooks/useShots'
import { useStageShortcuts } from '@/hooks/useStageShortcuts'
import { useProjectAspectClass } from '@/lib/aspect'
import { canRender, estimateRenderSeconds, formatEstimate, sceneTakeCount, shotLabel } from '@/lib/shots'
import type { Shot } from '@/lib/types'
import { plural } from '@/lib/utils'
import { announce, useUi } from '@/stores/ui'
import { useWorkspace } from '@/stores/workspace'
import { useStoryboard } from '@/features/storyboard/useStoryboard'
import { RenderQualityBar } from './RenderQuality'
import { useRenderOptions } from './renderOptions'
import { RenderShotRow } from './RenderShotRow'
import { takesInOrder, takeVideo } from './takes'

const SHORTCUTS: Shortcut[] = [
  [['J', 'K'], 'previous / next shot'],
  [['1–9'], 'pick a take'],
  [['Space'], 'play / pause the selected take'],
]

const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9']

export function RenderCanvas() {
  const board = useStoryboard()
  const { projectId, scene, groups } = board
  const project = useProject(projectId)
  const aspect = useProjectAspectClass()
  const takeId = useWorkspace((s) => s.selectedTake[projectId])
  const selectTake = useWorkspace((s) => s.selectTake)
  const [muted, setMuted] = useState(true)
  const [confirm, setConfirm] = useState(false)
  const renderScene = useRenderScene()
  const renderOpts = useRenderOptions(projectId)

  const group = groups.find((g) => g.scene.id === scene?.id)
  const shots = group?.shots ?? []
  const shot = shots.find((s) => s.id === board.selectedShot?.id)
  const takes = takesInOrder(useGenerations({ targetType: 'shot', targetId: shot?.id ?? '', kind: 'take' }, false).data)
  const perShot = project.data?.takes_per_shot ?? 3
  const eligible = shots.filter((s) => canRender(s, board.prevOf(s)))

  const pickShot = (s: Shot) => {
    board.selectFrame(s, 'start', false)
    selectTake(projectId, undefined)
  }
  const pickTake = (s: Shot, id: string) => {
    board.selectFrame(s, 'start', false)
    selectTake(projectId, id)
    useUi.getState().setInspectorOpen(true)
  }
  const step = (dir: 1 | -1) => {
    const i = shot ? shots.indexOf(shot) + dir : dir === 1 ? 0 : shots.length - 1
    if (shots[i]) pickShot(shots[i])
  }

  const keys: Record<string, () => void> = {
    j: () => step(-1),
    k: () => step(1),
    ' ': () => {
      const v = takeId ? takeVideo(takeId) : null
      if (!v) return
      if (v.paused) void v.play().catch(() => {})
      else v.pause()
    },
  }
  DIGITS.forEach((d, i) => {
    keys[d] = () => {
      if (shot && takes[i]) pickTake(shot, takes[i].id)
    }
  })
  useStageShortcuts(keys)

  if (board.scenes.isPending || board.shots.isPending) {
    return (
      <div className="flex flex-col gap-3 p-5" role="status" aria-label="Loading shots">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-40" />
      </div>
    )
  }
  const loadError = board.scenes.error ?? board.shots.error
  if (loadError) {
    return (
      <div className="mx-auto max-w-lg p-8">
        <ErrorState title="Couldn't load the shots" error={loadError} onRetry={() => board.shots.refetch()} />
      </div>
    )
  }

  const totalTakes = eligible.reduce((n, s) => n + sceneTakeCount(s, perShot), 0)
  const estimate = formatEstimate(estimateRenderSeconds(eligible, perShot))
  const storyboardHref = `/projects/${projectId}/storyboard`

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-start justify-between gap-3 px-5 pb-3 pt-4">
        <div className="min-w-0">
          <h1 className="flex items-center gap-1 text-title font-display font-semibold">
            Render
            <ShortcutHelp shortcuts={SHORTCUTS} />
          </h1>
          <p className="truncate text-small text-studio-muted">
            {group ? `Scene ${group.index + 1} · ${scene?.heading || 'Untitled scene'} · ` : ''}
            {plural(eligible.length, 'shot')} ready of {shots.length} · approve one take per shot
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="ghost"
            aria-pressed={!muted}
            onClick={() => setMuted((m) => !m)}
            title="Takes carry native audio"
          >
            {muted ? <VolumeX aria-hidden /> : <Volume2 aria-hidden />}
            {muted ? 'Muted' : 'Sound on'}
          </Button>
          <Button variant="primary" disabled={eligible.length === 0} onClick={() => setConfirm(true)} loading={renderScene.isPending}>
            <Clapperboard aria-hidden />
            Render scene
          </Button>
        </div>
      </header>
      <RenderQualityBar projectId={projectId} />
      {renderScene.isError && <ErrorState compact className="mx-5 mb-3" title="Couldn't queue the scene" error={renderScene.error} />}

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-3 px-5 pb-8">
          {!scene || shots.length === 0 ? (
            <EmptyState
              icon={<LayoutGrid />}
              title={scene ? 'No shots in this scene yet' : 'No scenes yet'}
              action={
                <Button asChild variant="primary">
                  <Link to={storyboardHref}>Go to Storyboard</Link>
                </Button>
              }
            >
              Takes are rendered from approved START and END frames. Build and approve them in the Storyboard first.
            </EmptyState>
          ) : (
            shots.map((s, i) => (
              <RenderShotRow
                key={s.id}
                shot={s}
                prev={board.prevOf(s)}
                label={shotLabel(group!.index, i)}
                defaultCount={perShot}
                selected={shot?.id === s.id}
                selectedTakeId={shot?.id === s.id ? takeId : undefined}
                muted={muted}
                aspectClass={aspect}
                storyboardHref={storyboardHref}
                onSelectShot={() => pickShot(s)}
                onSelectTake={(t) => pickTake(s, t.id)}
                onOpenStoryboard={() => board.selectFrame(s, 'start', false)}
                onExtended={pickShot}
              />
            ))
          )}
        </div>
      </ScrollArea>

      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Render ${plural(totalTakes, 'take')}?`}
        description={
          <>
            {plural(eligible.length, 'shot')} with approved frames × {perShot} takes each, queued in shot order so linked
            seams render after the frame they share. Estimated GPU time ≈ {estimate} once the video model is warm, plus 1–2 min
            if it has to load first.
            {eligible.length < shots.length && ` ${plural(shots.length - eligible.length, 'shot')} without an approved START will be skipped.`}
            {renderOpts.quality === 'hq' && ' High quality applies to single-chunk shots; long takes render in Standard.'}
          </>
        }
        confirmLabel={`Render ${plural(totalTakes, 'take')}`}
        onConfirm={() =>
          scene &&
          renderScene.mutate(
            { sceneId: scene.id, count: perShot },
            { onSuccess: (jobs) => announce(`${plural(jobs.length, 'take')} queued.`) },
          )
        }
      />
    </div>
  )
}
