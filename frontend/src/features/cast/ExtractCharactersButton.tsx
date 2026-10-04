import { useEffect, useRef } from 'react'
import { ScanText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip } from '@/components/ui/tooltip'
import { useAiJob } from '@/hooks/useAi'
import { useScenes } from '@/hooks/useScenes'
import { api } from '@/lib/api'
import { announce } from '@/stores/ui'

export function ExtractCharactersButton({ projectId, onError }: { projectId: string; onError: (e: unknown) => void }) {
  const scenes = useScenes(projectId)
  const extract = useAiJob(() => api.ai.extractCharacters(projectId))
  const hasScript = (scenes.data ?? []).some((s) => s.script_text?.trim())
  const reported = useRef<string | null>(null)
  const { job, error } = extract

  useEffect(() => {
    if (!job || reported.current === job.id + job.status) return
    if (job.status === 'done') {
      reported.current = job.id + job.status
      const r = job.result ?? {}
      const made = (r.created_ids as string[] | undefined)?.length ?? 0
      const sugg = r.suggestion_ids?.length ?? 0
      announce(`Found characters: ${made} new${sugg ? `, ${sugg} description suggestion${sugg > 1 ? 's' : ''}` : ''}.`)
    }
  }, [job])

  useEffect(() => {
    onError(error)
  }, [error, onError])

  const label = extract.working
    ? job?.status === 'running'
      ? job.message || 'Reading the script…'
      : 'Waiting for a worker…'
    : 'Extract from script'

  return (
    <Tooltip content={hasScript ? 'AI reads every scene and adds the characters it finds, with looks for image generation' : 'Write some script first'}>
      <Button
        variant="secondary"
        aria-disabled={!hasScript || undefined}
        loading={extract.working && !job}
        onClick={() => hasScript && !extract.working && extract.run(undefined)}
        className="max-w-72"
      >
        <ScanText aria-hidden className={extract.working ? 'animate-pulse' : undefined} />
        <span className="truncate">{label}</span>
      </Button>
    </Tooltip>
  )
}
