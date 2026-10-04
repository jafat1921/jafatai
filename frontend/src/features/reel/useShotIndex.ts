import { useMemo } from 'react'
import { shotLabel } from '@/lib/shots'
import type { Shot } from '@/lib/types'
import { useStoryboard } from '@/features/storyboard/useStoryboard'

/** shot id → shot and its "2.3" label, plus a way to jump to it in Render. */
export function useShotIndex() {
  const board = useStoryboard()
  const index = useMemo(() => {
    const m = new Map<string, { shot: Shot; label: string }>()
    for (const g of board.groups) g.shots.forEach((s, i) => m.set(s.id, { shot: s, label: shotLabel(g.index, i) }))
    return m
  }, [board.groups])

  return {
    projectId: board.projectId,
    shotFor: (id: string) => index.get(id),
    labelFor: (id: string) => index.get(id)?.label ?? '?',
    // Render opens on the shot's scene with the shot selected
    openInRender: (shot: Shot) => board.selectFrame(shot, 'start', false),
  }
}
