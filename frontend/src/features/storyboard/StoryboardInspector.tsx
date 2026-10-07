import { ImageIcon, Link2, MousePointerClick, RefreshCcw, ScrollText, Video, Wand2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { EmptyState, ErrorState } from '@/components/studio/states'
import { StatusPill } from '@/components/studio/status-pill'
import { GenerationViewer } from '@/components/review/GenerationViewer'
import { StudioImageModelField } from '@/components/models/StudioImageModel'
import { useStudioImageModel } from '@/hooks/useStudioImageModel'
import { useGenerationActions, useGenerations } from '@/hooks/useGenerations'
import { useClearStale } from '@/hooks/useShots'
import { useProjectAspectClass } from '@/lib/aspect'
import { shotLabel, startFrameOf } from '@/lib/shots'
import { shotStatus, staleStatus } from '@/lib/status'
import type { Shot } from '@/lib/types'
import { cn } from '@/lib/utils'
import { announce } from '@/stores/ui'
import type { FrameSide } from '@/stores/workspace'
import { RefsStrip } from './RefsStrip'
import { ShotCamera } from './ShotCamera'
import { ShotPrompts } from './ShotPrompts'
import { useStoryboard } from './useStoryboard'

function GenerateFirst({ shot, side, label }: { shot: Shot; side: FrameSide; label: string }) {
  const kind = side === 'start' ? 'keyframe_start' : 'keyframe_end'
  const target = { targetType: 'shot' as const, targetId: shot.id, kind } as const
  const list = useGenerations(target, false)
  const { create } = useGenerationActions()
  const imageModel = useStudioImageModel(shot.project_id)
  if (list.isPending || (list.data?.length ?? 0) > 0) return null
  return (
    <>
      <Button
        variant="primary"
        className="w-full"
        loading={create.isPending}
        onClick={() =>
          create.mutate({ target, params: imageModel.params }, { onSuccess: () => announce(`${side.toUpperCase()} frame for ${label} queued.`) })
        }
      >
        <Wand2 aria-hidden />
        Generate {side.toUpperCase()} frame
      </Button>
      {create.isError && <ErrorState compact title="Couldn't start the generation" error={create.error} />}
    </>
  )
}

export function StoryboardInspector() {
  const board = useStoryboard()
  const aspect = useProjectAspectClass()
  const clearStale = useClearStale()
  const shot = board.selectedShot
  const side = board.selection?.frame ?? 'start'

  if (!shot) {
    return (
      <EmptyState icon={<MousePointerClick />} title="No frame selected">
        Pick a START or END frame on the canvas to review it, or use <kbd>J</kbd>/<kbd>K</kbd> and <kbd>[</kbd>/<kbd>]</kbd>.
      </EmptyState>
    )
  }

  const group = board.groups.find((g) => g.scene.id === shot.scene_id)
  const label = group ? shotLabel(group.index, group.shots.indexOf(shot)) : ''
  const prev = board.prevOf(shot)
  const start = startFrameOf(shot, prev)
  const linked = side === 'start' && start.linked
  const prevGroup = prev && board.groups.find((g) => g.scene.id === prev.scene_id)
  const prevLabel = prev && prevGroup ? shotLabel(prevGroup.index, prevGroup.shots.indexOf(prev)) : 'previous shot'
  const subject = `${side === 'start' ? 'START' : 'END'} frame of shot ${label}`

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="min-w-0 flex-1 truncate text-heading font-semibold">
          Shot {label} · {side === 'start' ? 'START' : 'END'}
        </h2>
        <StatusPill status={shotStatus(shot.status)} />
      </div>
      {shot.stale && (
        <div className="flex items-center gap-2 rounded-[6px] border border-studio-warning/35 bg-studio-warning/10 px-2 py-1.5">
          <StatusPill status={staleStatus} />
          <span className="flex-1 text-small text-studio-muted">Something upstream changed since these frames were made.</span>
          <Button size="sm" variant="ghost" onClick={() => clearStale.mutate(shot.id)} loading={clearStale.isPending}>
            <RefreshCcw aria-hidden />
            Clear stale
          </Button>
        </div>
      )}

      <Tabs defaultValue="frame" className="flex flex-col gap-3">
        <TabsList aria-label="Shot sections">
          <TabsTrigger value="frame">
            <ImageIcon aria-hidden />
            Frame
          </TabsTrigger>
          <TabsTrigger value="prompts">
            <ScrollText aria-hidden />
            Prompts
          </TabsTrigger>
          <TabsTrigger value="camera">
            <Video aria-hidden />
            Camera
          </TabsTrigger>
        </TabsList>
        <TabsContent value="frame" className="flex flex-col gap-4">
          {linked ? (
            <div className="flex flex-col gap-2">
              <figure className={cn('darkroom relative w-full overflow-hidden rounded-[6px]', aspect)}>
                {start.frame?.media_url ? (
                  <img src={start.frame.media_url} alt={`${prevLabel} END frame, shared as this START`} className="size-full object-contain" />
                ) : (
                  <span className="flex size-full items-center justify-center text-small text-studio-on-dark-muted">
                    Waiting for {prevLabel} END
                  </span>
                )}
              </figure>
              <p className="flex items-start gap-1.5 text-small text-studio-muted">
                <Link2 aria-hidden className="mt-0.5 size-3.5 shrink-0 text-studio-accent-hover" />
                Linked: this START is {prevLabel}&apos;s END frame (Continue seam). Review and regenerate it there; switch the
                seam to Cut for a fresh START.
              </p>
              {prev && (
                <Button size="sm" variant="secondary" className="self-start" onClick={() => board.selectFrame(prev, 'end', false)}>
                  Go to {prevLabel} END
                </Button>
              )}
            </div>
          ) : (
            <>
              <GenerateFirst key={`${shot.id}:${side}`} shot={shot} side={side} label={label} />
              {/* keyed so versions/dialog state never leak between frames */}
              <GenerationViewer
                key={`${shot.id}:${side}`}
                target={{ targetType: 'shot', targetId: shot.id, kind: side === 'start' ? 'keyframe_start' : 'keyframe_end' }}
                subject={subject}
                aspectClass={aspect}
                emptyHint={`No ${side.toUpperCase()} frame yet.`}
              />
            </>
          )}
          <RefsStrip shot={shot} sceneLocationId={group?.scene.location_id} />
          <StudioImageModelField projectId={shot.project_id} withRefsNote />
        </TabsContent>
        <TabsContent value="prompts">
          <ShotPrompts key={shot.id} shot={shot} />
        </TabsContent>
        <TabsContent value="camera">
          <ShotCamera shot={shot} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
