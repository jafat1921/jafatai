import { Link } from 'react-router'
import { Keyboard } from 'lucide-react'
import { useJobs } from '@/hooks/useJobs'
import { useSystemStatus } from '@/hooks/useSystemStatus'
import type { Job } from '@/lib/types'
import { cn } from '@/lib/utils'

// edits and mixes run on the general (CPU) lane but belong to this room all the same
const AUDIO_JOB = /^audio_/
const isAudioJob = (j: Job) => j.lane === 'audio' || AUDIO_JOB.test(j.type)

function Dot({ on, warn }: { on: boolean; warn?: boolean }) {
  return <span aria-hidden className={cn('inline-block size-1.5 rounded-full', on ? 'bg-studio-success' : warn ? 'bg-studio-warning' : 'bg-studio-faint')} />
}

/** Queue and helper status, one dense line: what the audio lane is doing and whether the writer is up. */
export function StatusStrip({ onShortcuts }: { onShortcuts: () => void }) {
  const jobs = (useJobs().data ?? []).filter(isAudioJob)
  const running = jobs.filter((j) => j.status === 'running')
  const queued = jobs.filter((j) => j.status === 'queued').length
  const gpu = running.find((j) => j.gpu)?.gpu
  const llm = useSystemStatus().data?.llm

  return (
    <div className="flex h-6 shrink-0 items-center gap-3 border-t border-studio-border bg-studio-bg px-3 text-[11px] text-studio-muted">
      <Link to="/queue" className="flex items-center gap-1.5 hover:text-studio-text" aria-label={`Audio queue: ${running.length} running, ${queued} waiting${gpu ? ` on ${gpu}` : ''}. Open the queue`}>
        <Dot on={running.length > 0} />
        <span aria-hidden>
          Audio queue · {running.length} running · {queued} waiting
          {gpu ? <span className="text-studio-faint"> · {gpu}</span> : null}
        </span>
      </Link>
      {llm && (
        <span className="flex items-center gap-1.5" title={llm.ok ? 'The lyrics writer and translator are online' : (llm.error ?? 'Offline')}>
          <Dot on={llm.ok} warn={!llm.ok} />
          LLM {llm.ok ? 'online' : 'offline'}
        </span>
      )}
      <button type="button" onClick={onShortcuts} className="ml-auto flex items-center gap-1 rounded-[4px] px-1 hover:text-studio-text" aria-keyshortcuts="Shift+?" aria-label="Keyboard shortcuts">
        <Keyboard aria-hidden className="size-3.5" />
        <span aria-hidden>?</span>
      </button>
    </div>
  )
}
