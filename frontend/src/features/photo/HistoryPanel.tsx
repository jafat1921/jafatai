import { useState } from 'react'
import { Check, Columns2, Download, ExternalLink, ImageOff, Loader2, RotateCcw, SlidersHorizontal, Star } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ErrorState } from '@/components/studio/states'
import { StatusPill } from '@/components/studio/status-pill'
import { downloadUrl } from '@/lib/media'
import { editLabel, summarise } from '@/lib/photo/history'
import type { HistoryVersion, PhotoHistory } from '@/lib/photo/types'
import { generationStatus, isPendingGeneration } from '@/lib/status'
import { cn, timeAgo } from '@/lib/utils'

interface Props {
  history: PhotoHistory
  openedId: string
  busy: string | null
  error: unknown
  onLoad: (v: HistoryVersion) => void
  onOpen: (id: string) => void
  onRevert: (v: HistoryVersion) => void
  onApprove: (v: HistoryVersion) => void
  onRestore: (v: HistoryVersion) => void
  onCompare: (a: HistoryVersion, b: HistoryVersion) => void
}

const thumb = (v: HistoryVersion) => v.generation.thumb_url ?? (v.generation.media_type === 'image/tiff' ? null : v.generation.media_url)

/** Every version with what made it. Load its settings, open it, make it current, or tick two to compare. */
export function HistoryPanel({ history, openedId, busy, error, onLoad, onOpen, onRevert, onApprove, onRestore, onCompare }: Props) {
  const [ticked, setTicked] = useState<string[]>([])
  const project = history.target_type !== 'media'
  const tick = (id: string) => setTicked((t) => (t.includes(id) ? t.filter((x) => x !== id) : [...t.slice(-1), id]))
  const pair = ticked.map((id) => history.versions.find((v) => v.generation.id === id)).filter(Boolean) as HistoryVersion[]

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-small text-studio-muted">Tick two versions to compare them.</p>
        <Button
          size="sm"
          variant="secondary"
          disabled={pair.length !== 2}
          onClick={() => {
            const [a, b] = [...pair].sort((x, y) => x.generation.version - y.generation.version)
            onCompare(a, b)
          }}
        >
          <Columns2 aria-hidden />
          Compare
        </Button>
      </div>
      {error != null && <ErrorState compact title="That didn't work" error={error} />}
      <ol className="flex flex-col gap-2" aria-label="Versions">
        {history.versions.map((v) => {
          const g = v.generation
          const pending = isPendingGeneration(g.status)
          const finished = g.status === 'ready' || g.status === 'approved'
          const src = thumb(v)
          return (
            <li
              key={g.id}
              className={cn('flex gap-2 rounded-[6px] border bg-studio-raised p-2', g.id === openedId ? 'border-studio-accent ring-1 ring-studio-accent' : 'border-studio-border')}
            >
              <div className="darkroom relative size-16 shrink-0 overflow-hidden rounded-[4px]">
                {pending ? (
                  <Loader2 aria-hidden className="m-auto mt-5 size-5 text-studio-on-dark-muted motion-safe:animate-spin" />
                ) : src ? (
                  <img src={src} alt="" className="size-full object-cover" loading="lazy" />
                ) : (
                  <ImageOff aria-hidden className="m-auto mt-5 size-5 text-studio-on-dark-muted" />
                )}
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-mono text-small font-semibold">v{g.version}</span>
                  <span className="text-small">{editLabel(v)}</span>
                  {v.current && (
                    <span className="inline-flex items-center gap-0.5 rounded-[4px] border border-studio-success/50 px-1 text-[11px] text-studio-success">
                      <Star aria-hidden className="size-3" /> Current
                    </span>
                  )}
                  <label className="ml-auto flex items-center gap-1 text-[12px] text-studio-muted">
                    <input type="checkbox" checked={ticked.includes(g.id)} onChange={() => tick(g.id)} disabled={!src || pending} aria-label={`Compare v${g.version}`} />
                  </label>
                </div>
                {v.develop && <p className="truncate text-[12px] text-studio-muted" title={summarise(v.develop.params, 20)}>{summarise(v.develop.params)}</p>}
                <div className="flex items-center gap-1.5 text-[12px] text-studio-muted">
                  <StatusPill status={generationStatus(g.status)} />
                  <span>{timeAgo(g.created_at)}</span>
                </div>
                <div className="flex flex-wrap gap-1">
                  {v.develop && (
                    <Button size="sm" variant="ghost" className="h-6 px-1.5" onClick={() => onLoad(v)}>
                      <SlidersHorizontal aria-hidden />
                      Load settings
                    </Button>
                  )}
                  {g.id !== openedId && finished && (
                    <Button size="sm" variant="ghost" className="h-6 px-1.5" onClick={() => onOpen(g.id)}>
                      <ExternalLink aria-hidden />
                      Open
                    </Button>
                  )}
                  {!v.current && finished && (
                    <Button size="sm" variant="ghost" className="h-6 px-1.5" loading={busy === `revert:${g.id}`} onClick={() => onRevert(v)}>
                      <RotateCcw aria-hidden />
                      Make current
                    </Button>
                  )}
                  {project && g.status === 'ready' && (
                    <Button size="sm" variant="ghost" className="h-6 px-1.5" loading={busy === `approve:${g.id}`} onClick={() => onApprove(v)}>
                      <Check aria-hidden />
                      Approve
                    </Button>
                  )}
                  {g.status === 'rejected' && (
                    <Button size="sm" variant="ghost" className="h-6 px-1.5" onClick={() => onRestore(v)}>
                      <RotateCcw aria-hidden />
                      Restore
                    </Button>
                  )}
                  {finished && (
                    <Button asChild size="sm" variant="ghost" className="h-6 px-1.5">
                      <a href={downloadUrl(g.id)} download>
                        <Download aria-hidden />
                        Download
                      </a>
                    </Button>
                  )}
                </div>
              </div>
            </li>
          )
        })}
      </ol>
    </div>
  )
}
