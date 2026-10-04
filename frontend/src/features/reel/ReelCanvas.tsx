import { useState } from 'react'
import { Link } from 'react-router'
import { Film } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState, ErrorState } from '@/components/studio/states'
import { useMoveClip, useReel, useUpdateClip } from '@/hooks/useReel'
import { ApiError } from '@/lib/api'
import { useProjectAspectClass } from '@/lib/aspect'
import { moveClip } from '@/lib/reel'
import type { ReelClip } from '@/lib/types'
import { announce, useUi } from '@/stores/ui'
import { useWorkspace } from '@/stores/workspace'
import { MissingList } from './MissingList'
import { ReelHeader } from './ReelHeader'
import { ReelPlayer } from './ReelPlayer'
import { ReelRenders } from './ReelRenders'
import { SceneStrip } from './SceneStrip'
import { useShotIndex } from './useShotIndex'

export function ReelCanvas() {
  const shots = useShotIndex()
  const { projectId } = shots
  const reel = useReel(projectId)
  const aspect = useProjectAspectClass()
  const selectedClip = useWorkspace((s) => s.selectedClip[projectId])
  const selectClip = useWorkspace((s) => s.selectClip)
  const update = useUpdateClip(projectId)
  const move = useMoveClip(projectId)
  const [assembling, setAssembling] = useState(false)

  if (reel.isPending) {
    return (
      <div className="flex flex-col gap-3 p-5" role="status" aria-label="Loading the reel">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-32" />
        <Skeleton className="h-32" />
      </div>
    )
  }
  if (reel.isError) {
    const notHere = reel.error instanceof ApiError && reel.error.status === 404
    return (
      <div className="mx-auto max-w-lg p-8">
        <ErrorState
          title={notHere ? "The Reel isn't available on this server yet" : "Couldn't load the reel"}
          error={reel.error}
          onRetry={() => reel.refetch()}
        />
      </div>
    )
  }

  const data = reel.data
  const scenes = [...data.scenes].sort((a, b) => a.order - b.order)
  const hasClips = scenes.some((s) => s.clips.length > 0)
  const renderHref = `/projects/${projectId}/render`

  const onSelect = (clip: ReelClip) => {
    selectClip(projectId, clip.id)
    useUi.getState().setInspectorOpen(true)
  }
  const onMove = (clip: ReelClip, dir: -1 | 1) => {
    const next = moveClip(data, clip.id, dir)
    if (!next) return
    move.mutate(
      { clipId: clip.id, dir, ids: next.ids },
      { onSuccess: () => announce(`Clip ${shots.labelFor(clip.shot_id)} moved ${dir < 0 ? 'earlier' : 'later'}.`) },
    )
  }

  return (
    <div className="flex h-full flex-col">
      <ReelHeader reel={data} projectId={projectId} confirming={assembling} setConfirming={setAssembling} />
      {(update.isError || move.isError) && (
        <ErrorState compact className="mx-5 mb-3" title="That change didn't save" error={update.error ?? move.error} />
      )}
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-4 px-5 pb-8">
          {!hasClips && (
            <EmptyState
              icon={<Film />}
              title="No approved takes yet"
              action={
                <Button asChild variant="primary">
                  <Link to={renderHref}>Go to Render</Link>
                </Button>
              }
            >
              The Reel lines up every shot's approved take in scene order. Approve takes in Render, then press Sync.
            </EmptyState>
          )}
          <MissingList missing={data.missing} projectId={projectId} shotFor={shots.shotFor} onOpen={shots.openInRender} />

          {scenes.map((s, i) => (
            <SceneStrip
              key={s.scene_id}
              scene={s}
              index={i}
              isFirstScene={i === 0}
              meta={(c) => ({ label: shots.labelFor(c.shot_id), description: shots.shotFor(c.shot_id)?.shot.description })}
              selectedClipId={selectedClip}
              moving={move.isPending}
              onSelect={onSelect}
              onMove={onMove}
              onPatch={(clip, patch) => update.mutate({ id: clip.id, patch })}
            />
          ))}
          {hasClips ? (
            <div className="@container">
              <div className="grid gap-4 @2xl:grid-cols-2">
                <section aria-label="Preview" className="flex flex-col gap-2">
                  <h2 className="section-label">Preview</h2>
                  <ReelPlayer reel={data} labelFor={shots.labelFor} aspectClass={aspect} />
                </section>
                <section aria-label="Renders" className="flex flex-col gap-2">
                  <h2 className="section-label">Assembled film</h2>
                  <ReelRenders projectId={projectId} aspectClass={aspect} onReassemble={() => setAssembling(true)} />
                </section>
              </div>
            </div>
          ) : null}
        </div>
      </ScrollArea>
    </div>
  )
}
