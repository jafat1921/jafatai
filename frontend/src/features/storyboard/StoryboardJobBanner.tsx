import { CheckCircle2, Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { ErrorState } from '@/components/studio/states'
import type { Job } from '@/lib/types'

// The parent storyboard job: its message carries the step ("Scene 3 of 8: writing the opening frame…").
export function StoryboardJobBanner({ job, error, onDismiss }: { job?: Job; error?: unknown; onDismiss: () => void }) {
  if (error && !job) return <ErrorState compact title="Couldn't start the storyboard" error={error} className="mx-5 mb-3" />
  if (!job) return null
  if (job.status === 'failed' || job.status === 'cancelled') {
    return (
      <ErrorState
        compact
        className="mx-5 mb-3"
        title={job.status === 'failed' ? 'Storyboard stopped' : 'Storyboard cancelled'}
        error={job.error || job.message || 'Scenes finished so far are kept.'}
      />
    )
  }
  const done = job.status === 'done'
  return (
    <div
      role="status"
      className="mx-5 mb-3 flex flex-col gap-2 rounded-[6px] border border-studio-border-strong bg-studio-raised px-3 py-2 shadow-card"
    >
      <div className="flex items-center gap-2">
        {done ? (
          <CheckCircle2 aria-hidden className="size-4 text-studio-success" />
        ) : (
          <Loader2 aria-hidden className="size-4 animate-spin text-studio-accent" />
        )}
        <span className="min-w-0 flex-1 truncate text-body">
          {done
            ? 'Storyboard written. Frames keep filling in as they render.'
            : job.status === 'queued'
              ? 'Waiting for a worker…'
              : job.message || 'Reading the script…'}
        </span>
        {done && (
          <Button size="icon-sm" variant="ghost" aria-label="Dismiss" onClick={onDismiss}>
            <X aria-hidden />
          </Button>
        )}
      </div>
      {!done && <Progress value={job.status === 'running' ? job.progress : null} label="Storyboard progress" />}
    </div>
  )
}
