import { useMemo } from 'react'
import { useProjectShots } from '@/hooks/useShots'
import { buildUnits, flatten, groupShots, type FrameUnit } from '@/lib/shots'
import type { Shot } from '@/lib/types'
import { useWorkspace, type FrameSide, type ShotSelection } from '@/stores/workspace'
import { useUi } from '@/stores/ui'
import { useProjectId, useSelectedScene } from '@/features/workspace/selection'

export function unitHas(unit: FrameUnit, sel: ShotSelection | undefined) {
  if (!sel) return false
  return sel.frame === 'start' ? unit.startShot.id === sel.shotId : unit.endShot.id === sel.shotId
}

/** Everything the Storyboard canvas, inspector and shortcuts share: grouped shots, rows, selection. */
export function useStoryboard() {
  const projectId = useProjectId()
  const { scenes, scene, select: selectScene } = useSelectedScene()
  const shots = useProjectShots(projectId)
  const storedView = useWorkspace((s) => s.storyboardView[projectId])
  const setView = useWorkspace((s) => s.setStoryboardView)
  const selection = useWorkspace((s) => s.selectedShot[projectId])
  const setSelection = useWorkspace((s) => s.selectShot)

  const groups = useMemo(() => groupShots(scenes.data ?? [], shots.data ?? []), [scenes.data, shots.data])
  const all = useMemo(() => flatten(groups), [groups])
  // one shot per scene reads best as a scene list; a broken-down scene reads best as shot rows
  const view = storedView ?? (groups.some((g) => g.shots.length > 1) ? 'shots' : 'scenes')
  const units = useMemo(() => buildUnits(view, groups, scene?.id), [view, groups, scene?.id])

  const selectedShot: Shot | undefined = all.find((s) => s.id === selection?.shotId)
  const selectedIndex = units.findIndex((u) => unitHas(u, selection))

  const selectFrame = (shot: Shot, frame: FrameSide, openInspector = true) => {
    setSelection(projectId, { shotId: shot.id, frame })
    if (shot.scene_id !== scene?.id) selectScene(shot.scene_id)
    // only matters below 1280 px, where the Inspector is a slide-over
    if (openInspector) useUi.getState().setInspectorOpen(true)
  }

  const selectUnit = (unit: FrameUnit, frame: FrameSide = selection?.frame ?? 'start') =>
    selectFrame(frame === 'start' ? unit.startShot : unit.endShot, frame, false)

  const step = (dir: 1 | -1) => {
    if (!units.length) return
    const next = selectedIndex === -1 ? (dir === 1 ? 0 : units.length - 1) : selectedIndex + dir
    if (next < 0 || next >= units.length) return
    selectUnit(units[next])
  }

  return {
    projectId,
    scenes,
    scene,
    selectScene,
    shots,
    groups,
    all,
    units,
    view,
    setView: (v: 'scenes' | 'shots') => setView(projectId, v),
    selection,
    selectedShot,
    selectedUnit: selectedIndex >= 0 ? units[selectedIndex] : undefined,
    selectFrame,
    selectUnit,
    step,
    prevOf: (s: Shot) => {
      const i = all.indexOf(s)
      return i > 0 ? all[i - 1] : undefined
    },
  }
}
