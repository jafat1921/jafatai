import { useEffect, useRef } from 'react'
import { ScanText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip } from '@/components/ui/tooltip'
import { useAiJob } from '@/hooks/useAi'
import { useScenes } from '@/hooks/useScenes'
import type { Job } from '@/lib/types'
import { announce } from '@/stores/ui'

interface Props {
  projectId: string
  start: () => Promise<Job>
  label: string
  hint: string
  summarize: (job: Job) => string
  onError: (e: unknown) => void
}

// "Extract X from script": an AI job that needs some script text to read.
export function AiExtractButton({ projectId, start, label, hint, summarize, onError }: Props) {
  const scenes = useScenes(projectId)
  const extract = useAiJob(start)
  const hasScript = (scenes.data ?? []).some((s) => s.script_text?.trim())
  const reported = useRef<string | null>(null)
  const { job, error } = extract

  useEffect(() => {
    if (!job || job.status !== 'done' || reported.current === job.id) return
    reported.current = job.id
    announce(summarize(job))
  }, [job, summarize])

  useEffect(() => {
    onError(error)
  }, [error, onError])

  const text = extract.working
    ? job?.status === 'running'
      ? job.message || 'Reading the script…'
      : 'Waiting for a worker…'
    : label

  return (
    <Tooltip content={hasScript ? hint : 'Write some script first'}>
      <Button
        variant="secondary"
        aria-disabled={!hasScript || undefined}
        loading={extract.working && !job}
        onClick={() => hasScript && !extract.working && extract.run(undefined)}
        className="max-w-72"
      >
        <ScanText aria-hidden className={extract.working ? 'animate-pulse' : undefined} />
        <span className="truncate">{text}</span>
      </Button>
    </Tooltip>
  )
}
