import { Fragment } from 'react'
import { ListChecks, Plus, Sparkles, Wand2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/studio/states'
import { useCreateShot, useUpdateShot } from '@/hooks/useShots'
import { useProjectAspectClass } from '@/lib/aspect'
import type { FrameUnit } from '@/lib/shots'
import type { Shot } from '@/lib/types'
import { announce } from '@/stores/ui'
import { FrameRow } from './FrameRow'
import { shotLabel } from '@/lib/shots'
import { SeamControl } from './SeamControl'
import { ShotListReview } from './ShotListReview'
import { StoryboardToolbar } from './StoryboardToolbar'
import { unitHas, type useStoryboard } from './useStoryboard'

type Board = ReturnType<typeof useStoryboard>

export function StoryboardList({ board, onStoryboardScene }: { board: Board; onStoryboardScene: (sceneId: string) => void }) {
  const aspect = useProjectAspectClass()
  const updateShot = useUpdateShot(board.projectId)
  const addShot = useCreateShot(board.projectId)

  const labelFor = (shot: Shot) => {
    const g = board.groups.find((x) => x.scene.id === shot.scene_id)
    return g ? shotLabel(g.index, g.shots.indexOf(shot)) : ''
  }
  const unitLabel = (u: FrameUnit) => (board.view === 'shots' ? labelFor(u.startShot) : `scene ${u.sceneIndex + 1}`)

  const row = (unit: FrameUnit) => {
    const sceneShots = board.groups.find((g) => g.scene.id === unit.scene.id)?.shots ?? []
    const prev = unit.prevShot
    return (
      <Fragment key={unit.key}>
        {prev && (
          <SeamControl
            value={unit.startShot.seam_in}
            fromLabel={board.view === 'shots' || prev.scene_id === unit.scene.id ? labelFor(prev) : `scene ${(board.groups.find((g) => g.scene.id === prev.scene_id)?.index ?? 0) + 1}`}
            toLabel={unitLabel(unit)}
            active={unitHas(unit, board.selection)}
            onChange={(seam_in) => {
              updateShot.mutate({ id: unit.startShot.id, patch: { seam_in } })
              announce(seam_in === 'continue' ? `Linked: ${unitLabel(unit)} opens on the previous END frame.` : `Cut before ${unitLabel(unit)}.`)
            }}
          />
        )}
        <FrameRow
          unit={unit}
          view={board.view}
          sceneShots={sceneShots}
          nextShot={board.all[board.all.indexOf(unit.endShot) + 1]}
          labelFor={labelFor}
          selection={board.selection}
          aspectClass={aspect}
          onSelectFrame={board.selectFrame}
          onOpenShots={() => {
            board.selectFrame(unit.startShot, 'start', false)
            board.setView('shots')
          }}
        />
      </Fragment>
    )
  }

  if (board.view === 'scenes') {
    return (
      <ol className="flex flex-col gap-1" aria-label="Scenes, first frame to last frame">
        {board.groups.map((g) => {
          const unit = board.units.find((u) => u.scene.id === g.scene.id)
          return (
            <li key={g.scene.id}>
              {unit && g.scene.shots_review === 'pending' ? (
                <div className="my-1 flex flex-wrap items-center gap-2 rounded-[6px] border border-studio-accent bg-studio-accent-soft px-3 py-2">
                  <span className="font-mono text-small text-studio-muted">Scene {g.index + 1}</span>
                  <span className="min-w-0 flex-1 truncate text-body">{g.scene.heading || 'Untitled scene'}</span>
                  <span className="text-small text-studio-muted">Shot list waiting for review · {g.shots.length} shots</span>
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => {
                      board.selectScene(g.scene.id)
                      board.setView('shots')
                    }}
                  >
                    <ListChecks aria-hidden />
                    Review shot list
                  </Button>
                </div>
              ) : unit ? (
                row(unit)
              ) : (
                <div className="my-1 flex flex-wrap items-center gap-2 rounded-[6px] border border-dashed border-studio-border-strong px-3 py-2">
                  <span className="font-mono text-small text-studio-muted">Scene {g.index + 1}</span>
                  <span className="min-w-0 flex-1 truncate text-body">{g.scene.heading || 'Untitled scene'}</span>
                  <span className="text-small text-studio-muted">No frames yet</span>
                  <Button size="sm" variant="secondary" onClick={() => onStoryboardScene(g.scene.id)}>
                    <Wand2 aria-hidden />
                    Storyboard this scene
                  </Button>
                </div>
              )}
            </li>
          )
        })}
      </ol>
    )
  }

  const scene = board.scene
  if (!scene) return null
  const sceneShots = board.groups.find((g) => g.scene.id === scene.id)?.shots ?? []

  return (
    <div className="flex flex-col gap-3">
      <StoryboardToolbar scene={scene} shots={sceneShots} prevOf={board.prevOf} />
      {scene.shots_review === 'pending' && sceneShots.length > 0 ? (
        <ShotListReview
          scene={scene}
          sceneIndex={board.groups.find((g) => g.scene.id === scene.id)?.index ?? 0}
          shots={sceneShots}
          firstShotId={board.all[0]?.id}
        />
      ) : sceneShots.length === 0 ? (
        <EmptyState
          icon={<Sparkles />}
          title="Break this scene into shots"
          action={
            <>
              <Button variant="primary" onClick={() => onStoryboardScene(scene.id)}>
                <Wand2 aria-hidden />
                Storyboard from script
              </Button>
              <Button variant="secondary" loading={addShot.isPending} onClick={() => addShot.mutate({ sceneId: scene.id })}>
                <Plus aria-hidden />
                Add shot
              </Button>
            </>
          }
        >
          Let the AI frame it from the script (or use Suggest shots above), or add shots by hand.
        </EmptyState>
      ) : (
        <ol className="flex flex-col gap-1" aria-label={`Shots in scene ${(board.groups.find((g) => g.scene.id === scene.id)?.index ?? 0) + 1}`}>
          {board.units.map((u) => (
            <li key={u.key}>{row(u)}</li>
          ))}
        </ol>
      )}
    </div>
  )
}
