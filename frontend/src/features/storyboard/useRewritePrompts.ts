import { useState } from 'react'
import { useAiJob } from '@/hooks/useAi'
import { useUpdateShot } from '@/hooks/useShots'
import { api } from '@/lib/api'
import type { Shot } from '@/lib/types'

/**
 * compile-prompts is a no-op server-side for manual shots, so asking for a rewrite on one
 * first needs consent to flip it back to auto (and lose the hand-written prompts).
 */
export function useRewritePrompts(shot: Shot) {
  const job = useAiJob((id: string) => api.ai.compilePrompts(id))
  const update = useUpdateShot(shot.project_id)
  const [confirming, setConfirming] = useState(false)

  const request = () => {
    if (job.working) return
    if (shot.prompt_mode === 'manual') setConfirming(true)
    else job.run(shot.id)
  }

  const confirm = () => {
    setConfirming(false)
    update.mutate({ id: shot.id, patch: { prompt_mode: 'auto' } }, { onSuccess: () => job.run(shot.id) })
  }

  return {
    request,
    confirm,
    confirming,
    setConfirming,
    working: job.working,
    status: job.working ? (job.job?.status === 'running' ? job.job.message || 'Writing prompts…' : 'Waiting for a worker…') : '',
    error: job.error ?? update.error,
  }
}
