import { MousePointerClick } from 'lucide-react'
import { EmptyState } from '@/components/studio/states'
import { StatusPill } from '@/components/studio/status-pill'
import { GenerationViewer } from '@/components/review/GenerationViewer'
import { useProjectAspectClass } from '@/lib/aspect'
import { shotLabel } from '@/lib/shots'
import { shotStatus } from '@/lib/status'
import { useWorkspace } from '@/stores/workspace'
import { useStoryboard } from '@/features/storyboard/useStoryboard'

export function RenderInspector() {
  const board = useStoryboard()
  const aspect = useProjectAspectClass()
  const takeId = useWorkspace((s) => s.selectedTake[board.projectId])
  const selectTake = useWorkspace((s) => s.selectTake)
  const shot = board.selectedShot

  if (!shot) {
    return (
      <EmptyState icon={<MousePointerClick />} title="No take selected">
        Pick a take on the canvas, or press <kbd>1</kbd>–<kbd>9</kbd> on a selected shot.
      </EmptyState>
    )
  }
  const group = board.groups.find((g) => g.scene.id === shot.scene_id)
  const label = group ? shotLabel(group.index, group.shots.indexOf(shot)) : ''

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="min-w-0 flex-1 truncate text-heading font-semibold">Shot {label} · takes</h2>
        <StatusPill status={shotStatus(shot.status)} />
      </div>
      <p className="text-small text-studio-muted">
        Approving a take makes it the one used in the Reel. Only one take per shot is approved.
      </p>
      <GenerationViewer
          key={shot.id}
          target={{ targetType: 'shot', targetId: shot.id, kind: 'take' }}
          subject={`Take of shot ${label}`}
          aspectClass={aspect}
          viewId={takeId}
          onViewIdChange={(id) => selectTake(board.projectId, id)}
          emptyHint="No takes yet. Press Render takes on the shot."
        />
    </div>
  )
}
