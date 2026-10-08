import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, Columns2, Download, Loader2, SplitSquareHorizontal, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { BeforeAfter } from '@/components/media/BeforeAfter'
import { useJob } from '@/hooks/useJobs'
import { api } from '@/lib/api'
import { downloadUrl } from '@/lib/media'
import type { UpscaleEntry } from '@/lib/upscaleHistory'
import type { Generation, MediaKind } from '@/lib/types'

const READY = new Set(['ready', 'approved'])

function useGen(id: string, poll: boolean) {
  return useQuery({
    queryKey: ['generation', id],
    queryFn: () => api.generations.get(id),
    refetchInterval: (q) => (poll && !READY.has((q.state.data as Generation | undefined)?.status ?? '') ? 3000 : false),
  })
}

function Panel({ gen, title, kind, onSize }: { gen?: Generation; title: string; kind: MediaKind; onSize?: (s: string) => void }) {
  const [size, setSize] = useState<string | null>(null)
  const report = (w: number, h: number) => {
    const s = `${w}×${h}`
    setSize(s)
    onSize?.(s)
  }
  return (
    <figure className="flex min-w-0 flex-1 flex-col gap-2">
      <div className="darkroom relative flex aspect-video items-center justify-center overflow-hidden">
        {gen?.media_url && READY.has(gen.status) ? (
          kind === 'video' ? (
            <video
              src={gen.media_url}
              controls
              playsInline
              preload="metadata"
              className="absolute inset-0 size-full object-contain"
              onLoadedMetadata={(e) => report(e.currentTarget.videoWidth, e.currentTarget.videoHeight)}
            />
          ) : (
            <img
              src={gen.media_url}
              alt={`${title} image`}
              className="absolute inset-0 size-full object-contain"
              onLoad={(e) => report(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)}
            />
          )
        ) : (
          <Loader2 aria-hidden className="size-6 animate-spin text-studio-on-dark-muted" />
        )}
      </div>
      <figcaption className="flex items-center justify-between gap-2">
        <span className="text-body">
          <span className="font-semibold">{title}</span>
          {size && <span className="ml-2 font-mono text-small text-studio-muted">{size}</span>}
        </span>
        {gen && READY.has(gen.status) && (
          <Button asChild variant="secondary" size="sm">
            <a href={downloadUrl(gen.id)} download aria-label={`Download ${title.toLowerCase()} ${kind}`}>
              <Download aria-hidden />
              Download
            </a>
          </Button>
        )}
      </figcaption>
    </figure>
  )
}

function ResultCard({ entry, onRemove }: { entry: UpscaleEntry; onRemove: () => void }) {
  const job = useJob(entry.jobId)
  const result = useGen(entry.resultId, true)
  const source = useGen(entry.sourceId, false)
  const [compare, setCompare] = useState(false)
  const done = !!result.data && READY.has(result.data.status)
  const failed = job?.status === 'failed' || result.data?.status === 'failed'
  const running = !done && !failed

  return (
    <article className="flex flex-col gap-3 rounded-[6px] border border-studio-border-strong bg-studio-panel p-3 shadow-card" aria-label={`Upscale: ${entry.label}`}>
      <header className="flex flex-wrap items-center gap-2">
        <h3 className="font-display text-panel font-semibold">{entry.label}</h3>
        <span className="text-small text-studio-muted">{new Date(entry.at).toLocaleString()}</span>
        <div className="ml-auto flex items-center gap-1">
          {done && entry.kind === 'image' && (
            <Button variant="ghost" size="sm" aria-pressed={compare} onClick={() => setCompare((c) => !c)}>
              {compare ? <Columns2 aria-hidden /> : <SplitSquareHorizontal aria-hidden />}
              {compare ? 'Side by side' : 'Compare slider'}
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={onRemove} aria-label="Remove from this list">
            <X aria-hidden />
          </Button>
        </div>
      </header>

      {running && (
        <div className="flex flex-col gap-1" aria-live="polite">
          <Progress value={job?.status === 'running' ? job.progress : null} label="Upscale progress" />
          <p className="text-small text-studio-muted">{job?.message || 'Waiting for the GPU…'}</p>
        </div>
      )}
      {failed && (
        <p role="alert" className="flex items-center gap-2 text-body text-studio-danger">
          <AlertTriangle aria-hidden className="size-4" />
          {job?.error || 'The upscale failed.'}
        </p>
      )}

      {compare && done && source.data?.media_url && result.data?.media_url ? (
        <BeforeAfter
          before={source.data.media_url}
          after={result.data.media_url}
          alt="Original and upscaled"
          beforeLabel="Original"
          afterLabel="Upscaled"
          aspectClass="aspect-video"
        />
      ) : (
        <div className="flex flex-col gap-3 md:flex-row">
          <Panel gen={source.data} title="Original" kind={entry.kind} />
          <Panel gen={result.data} title="Upscaled" kind={entry.kind} />
        </div>
      )}
    </article>
  )
}

export function UpscaleResults({ entries, onRemove }: { entries: UpscaleEntry[]; onRemove: (resultId: string) => void }) {
  if (entries.length === 0) return null
  return (
    <section aria-labelledby="upscale-results" className="flex flex-col gap-3">
      <h2 id="upscale-results" className="section-label">
        Your upscales
      </h2>
      {entries.map((e) => (
        <ResultCard key={e.resultId} entry={e} onRemove={() => onRemove(e.resultId)} />
      ))}
    </section>
  )
}
