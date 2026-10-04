import { useState } from 'react'
import { useGenerationActions } from '@/hooks/useGenerations'
import { startFrameOf } from '@/lib/shots'
import type { Generation, GenerationKind, Shot } from '@/lib/types'
import { announce } from '@/stores/ui'

const needsFrame = (g: Generation | null | undefined) => !g || g.status === 'failed'

/** "Generate all frames" / "Approve all ready" for one scene. Requests go out in shot order. */
export function useSceneBatch(shots: Shot[], prevOf: (s: Shot) => Shot | undefined) {
  const { create, approve } = useGenerationActions()
  const [running, setRunning] = useState<'generate' | 'approve' | null>(null)
  const [error, setError] = useState<unknown>(null)

  const toGenerate: { shot: Shot; kind: GenerationKind }[] = []
  const toApprove: Generation[] = []
  for (const shot of shots) {
    const start = startFrameOf(shot, prevOf(shot))
    // a linked START is someone else's END, it gets generated (and approved) there
    if (!start.linked) {
      if (needsFrame(start.frame)) toGenerate.push({ shot, kind: 'keyframe_start' })
      else if (start.frame?.status === 'ready') toApprove.push(start.frame)
    }
    if (needsFrame(shot.end_frame)) toGenerate.push({ shot, kind: 'keyframe_end' })
    else if (shot.end_frame?.status === 'ready') toApprove.push(shot.end_frame)
  }

  const run = async (what: 'generate' | 'approve') => {
    setRunning(what)
    setError(null)
    try {
      if (what === 'generate') {
        for (const { shot, kind } of toGenerate) {
          await create.mutateAsync({ target: { targetType: 'shot', targetId: shot.id, kind } })
        }
        announce(`${toGenerate.length} frame${toGenerate.length === 1 ? '' : 's'} queued.`)
      } else {
        for (const g of toApprove) await approve.mutateAsync(g.id)
        announce(`${toApprove.length} frame${toApprove.length === 1 ? '' : 's'} approved.`)
      }
    } catch (e) {
      setError(e)
    } finally {
      setRunning(null)
    }
  }

  return {
    generateCount: toGenerate.length,
    approveCount: toApprove.length,
    generateAll: () => run('generate'),
    approveAll: () => run('approve'),
    running,
    error,
  }
}
