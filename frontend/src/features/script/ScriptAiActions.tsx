import { FastForward, Loader2, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip } from '@/components/ui/tooltip'
import { ErrorState } from '@/components/studio/states'
import { useAiJob } from '@/hooks/useAi'
import { api } from '@/lib/api'
import type { Scene } from '@/lib/types'

// Film-level actions for the scenes column: fill the empty stubs, or append what happens next.
export function ScriptAiActions({ projectId, scenes }: { projectId: string; scenes: Scene[] }) {
  const missing = useAiJob(() => api.ai.writeMissing(projectId))
  const cont = useAiJob(() => api.ai.continueStory(projectId, 1))
  const empty = scenes.filter((s) => !s.script_text?.trim()).length
  const anyWritten = scenes.some((s) => s.script_text?.trim())
  const busy = missing.working || cont.working
  const running = missing.working ? missing : cont.working ? cont : null

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-col gap-1">
        <Tooltip content={empty ? `AI drafts the ${empty} empty scene${empty > 1 ? 's' : ''} from the scenes around them` : 'Add an empty scene where the gap is first'}>
          <Button
            size="sm"
            variant="secondary"
            className="w-full justify-start"
            aria-disabled={!empty || busy || undefined}
            onClick={() => empty && !busy && missing.run(undefined)}
          >
            <Sparkles aria-hidden />
            Write missing scenes{empty ? ` (${empty})` : ''}
          </Button>
        </Tooltip>
        <Tooltip content={anyWritten ? 'AI writes the next scene after the last one' : 'Write a scene first'}>
          <Button
            size="sm"
            variant="secondary"
            className="w-full justify-start"
            aria-disabled={!anyWritten || busy || undefined}
            onClick={() => anyWritten && !busy && cont.run(undefined)}
          >
            <FastForward aria-hidden />
            Continue story
          </Button>
        </Tooltip>
      </div>
      {running && (
        <p role="status" className="inline-flex items-center gap-1.5 text-small text-studio-muted">
          <Loader2 aria-hidden className="size-3 shrink-0 animate-spin text-studio-accent" />
          <span className="truncate">
            {running.job?.status === 'queued' ? 'Waiting for a worker…' : running.job?.message || 'Starting…'}
          </span>
        </p>
      )}
      {(missing.error || cont.error) && (
        <ErrorState compact title="The AI couldn't write that" error={missing.error ?? cont.error} />
      )}
    </div>
  )
}
