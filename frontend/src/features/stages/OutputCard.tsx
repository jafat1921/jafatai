import { useId, useRef, useState } from 'react'
import { AlertTriangle, Check, Loader2, Pencil, Play, RotateCcw, Undo2, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { DownloadButton } from '@/features/reel/ReelRenders'
import { useJob, useJobAction } from '@/hooks/useJobs'
import { formatTimecode } from '@/lib/duration'
import { renderInfo, shortDate } from '@/lib/stitch'
import { isPendingGeneration } from '@/lib/status'
import type { Render } from '@/lib/types'
import { cn } from '@/lib/utils'

export interface OutputCardActions {
  onPlay: () => void
  onApprove: () => void
  onUnapprove: () => void
  onReject: () => void
  onRestore: () => void
  onRename: (title: string) => void
}

interface Props extends OutputCardActions {
  render: Render
  aspectClass: string
  reviewOnly: boolean
  busy: boolean
}

export function OutputCard({ render, aspectClass, reviewOnly, busy, ...on }: Props) {
  const info = renderInfo(render)
  const job = useJob(render.job_id)
  const cancel = useJobAction('cancel')
  const titleId = useId()
  const pending = isPendingGeneration(render.status)
  const playable = !!render.media_url && (render.status === 'ready' || render.status === 'approved')
  const meta = [info.range, info.durationS != null ? formatTimecode(info.durationS) : null, shortDate(render.created_at), `v${render.version}`]
    .filter(Boolean)
    .join(' · ')

  return (
    <article
      aria-labelledby={titleId}
      className={cn(
        'flex h-full flex-col overflow-hidden rounded-[6px] border bg-studio-panel shadow-card',
        render.status === 'approved' ? 'border-studio-accent' : 'border-studio-border-strong',
        render.status === 'rejected' && 'opacity-70',
      )}
    >
      <div className={cn('darkroom relative w-full', aspectClass)}>
        {playable ? (
          <>
            {/* first frame as a poster; the real player opens large */}
            <video src={render.media_url!} preload="metadata" muted playsInline tabIndex={-1} aria-hidden className="size-full object-contain" />
            <button
              type="button"
              onClick={on.onPlay}
              aria-label={`Play ${info.title}`}
              className="group absolute inset-0 flex items-center justify-center focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-studio-gold"
            >
              <span className="flex size-12 items-center justify-center rounded-full border border-studio-gold/70 bg-studio-darkroom/80 text-studio-on-dark transition-transform group-hover:scale-105">
                <Play aria-hidden className="ml-0.5 size-5" />
              </span>
            </button>
          </>
        ) : pending ? (
          <span className="shimmer-dark flex size-full items-center justify-center">
            <Loader2 aria-hidden className="size-6 animate-spin text-studio-on-dark-muted" />
          </span>
        ) : (
          <span className="flex size-full items-center justify-center gap-2 text-small text-studio-on-dark-muted">
            <AlertTriangle aria-hidden className="size-4" />
            {render.status === 'failed' ? 'Stitch failed' : 'No file'}
          </span>
        )}
        {render.status === 'approved' && (
          <Badge tone="success" className="absolute left-2 top-2 border-studio-gold/70 bg-studio-darkroom/85 text-studio-on-dark">
            <Check aria-hidden />
            Final film
          </Badge>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-2 p-3">
        <Title id={titleId} title={info.title} editable={!reviewOnly && !pending} onRename={on.onRename} />
        <p className="text-small text-studio-muted">{meta}</p>

        {pending ? (
          <div className="flex flex-col gap-1.5" role="status">
            <span className="text-small text-studio-muted">
              {render.status === 'queued' ? 'Waiting its turn' : job?.message || 'Stitching…'}
            </span>
            <Progress value={render.status === 'generating' ? (job?.progress ?? null) : null} label={`Stitching ${info.title}`} />
            {render.job_id && !reviewOnly && (
              <Button size="sm" variant="ghost" className="self-start" onClick={() => cancel.mutate(render.job_id!)}>
                <X aria-hidden />
                Cancel
              </Button>
            )}
          </div>
        ) : (
          <div className="mt-auto flex flex-wrap items-center gap-1.5">
            {playable && (
              <Button size="sm" variant="secondary" onClick={on.onPlay} aria-label={`Play ${info.title}`}>
                <Play aria-hidden />
                Play
              </Button>
            )}
            <DownloadButton render={render} label={`Download ${info.title}`} />
            {render.status === 'ready' && (
              <Button size="sm" variant="primary" onClick={on.onApprove} disabled={busy}>
                <Check aria-hidden />
                Approve as final
              </Button>
            )}
            {render.status === 'approved' && !reviewOnly && (
              <Button size="sm" variant="ghost" onClick={on.onUnapprove} disabled={busy}>
                <Undo2 aria-hidden />
                Unapprove
              </Button>
            )}
            {!reviewOnly && (render.status === 'ready' || render.status === 'failed') && (
              <Button size="sm" variant="ghost" onClick={on.onReject} disabled={busy} aria-label={`Reject ${info.title}`}>
                <X aria-hidden />
                Reject
              </Button>
            )}
            {!reviewOnly && render.status === 'rejected' && (
              <Button size="sm" variant="secondary" onClick={on.onRestore} disabled={busy}>
                <RotateCcw aria-hidden />
                Restore
              </Button>
            )}
          </div>
        )}
        {render.status === 'failed' && job?.error && <p className="text-small text-studio-danger">{job.error}</p>}
      </div>
    </article>
  )
}

function Title({ id, title, editable, onRename }: { id: string; title: string; editable: boolean; onRename: (t: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  const skipBlur = useRef(false)

  const save = () => {
    const t = (draft ?? '').trim()
    setDraft(null)
    if (t && t !== title) onRename(t)
  }

  if (draft !== null) {
    return (
      <Input
        autoFocus
        aria-label="Name"
        value={draft}
        maxLength={200}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (skipBlur.current) skipBlur.current = false
          else save()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            skipBlur.current = true
            save()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            skipBlur.current = true
            setDraft(null)
          }
        }}
      />
    )
  }
  return (
    <div className="flex items-start gap-1">
      <h3 id={id} className="min-w-0 flex-1 break-words font-display text-panel font-semibold">
        {title}
      </h3>
      {editable && (
        <Button size="icon-sm" variant="ghost" aria-label={`Rename ${title}`} onClick={() => setDraft(title)}>
          <Pencil aria-hidden />
        </Button>
      )}
    </div>
  )
}
