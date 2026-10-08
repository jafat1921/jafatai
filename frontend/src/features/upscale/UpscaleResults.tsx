import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { AlertTriangle, Columns2, Download, ExternalLink, Loader2, RefreshCw, SplitSquareHorizontal, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/alert-dialog'
import { Progress } from '@/components/ui/progress'
import { ErrorState } from '@/components/studio/states'
import { BeforeAfter } from '@/components/media/BeforeAfter'
import { useJob } from '@/hooks/useJobs'
import { useDeleteUpscale, useUpscaleList } from '@/hooks/useUpscales'
import { downloadUrl, upscaleLabel } from '@/lib/media'
import type { UpscaleEntry } from '@/lib/upscaleHistory'
import type { Generation, MediaKind, UpscaleRow } from '@/lib/types'
import { announce } from '@/stores/ui'

const READY = new Set(['ready', 'approved'])
const COLLAPSED = 6

const sizeOf = (g: Generation | null | undefined, w?: number | null, h?: number | null) => {
  const size = g?.params?.size
  if (Array.isArray(size) && size.length === 2) return `${size[0]}×${size[1]}`
  const p = g?.params ?? {}
  if (typeof p.width === 'number' && typeof p.height === 'number') return `${p.width}×${p.height}`
  return w && h ? `${w}×${h}` : null
}

function Panel({ gen, title, kind, size }: { gen?: Generation | null; title: string; kind: MediaKind; size: string | null }) {
  const ready = !!gen?.media_url && READY.has(gen.status)
  const [natural, setNatural] = useState<string | null>(null)
  const preview = gen?.thumb_url ?? gen?.media_url
  return (
    <figure className="flex min-w-0 flex-1 flex-col gap-2">
      <div className="darkroom relative flex aspect-video items-center justify-center overflow-hidden rounded-[6px]">
        {ready && preview ? (
          kind === 'video' ? (
            <video
              src={gen.media_url!}
              poster={gen.thumb_url ?? undefined}
              controls
              playsInline
              preload="none"
              className="absolute inset-0 size-full object-contain"
              aria-label={`${title} video`}
              onLoadedMetadata={(e) => setNatural(`${e.currentTarget.videoWidth}×${e.currentTarget.videoHeight}`)}
            />
          ) : (
            <img src={preview} alt={`${title} image`} loading="lazy" decoding="async" className="absolute inset-0 size-full object-contain" />
          )
        ) : gen?.status === 'failed' ? (
          <AlertTriangle aria-hidden className="size-6 text-studio-on-dark-muted" />
        ) : (
          <Loader2 aria-hidden className="size-6 motion-safe:animate-spin text-studio-on-dark-muted" />
        )}
      </div>
      <figcaption className="flex items-center justify-between gap-2">
        <span className="text-body">
          <span className="font-semibold">{title}</span>
          {(size ?? natural) && <span className="ml-2 font-mono text-small text-studio-muted">{size ?? natural}</span>}
        </span>
        {gen && ready && (
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

function ResultCard({ row, onAgain }: { row: UpscaleRow; onAgain?: (source: Generation, title: string) => void }) {
  const live = useJob(row.job?.id)
  const job = live ?? row.job ?? undefined
  const remove = useDeleteUpscale()
  const [compare, setCompare] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const done = READY.has(row.status)
  const failed = row.status === 'failed' || job?.status === 'failed'
  const running = !done && !failed
  const label = row.label ?? upscaleLabel(row.target)
  const source = row.source
  const library = row.media_id ? `/${row.kind}/library?open=${row.media_id}` : row.project_id ? `/projects/${row.project_id}/output` : null

  return (
    <article className="flex flex-col gap-3 rounded-[6px] border border-studio-border-strong bg-studio-panel p-3 shadow-card" aria-label={`Upscale: ${row.title}`}>
      <header className="flex flex-wrap items-center gap-2">
        <h3 className="font-display text-panel font-semibold">{row.title}</h3>
        {label && <span className="rounded-[4px] bg-studio-raised px-1.5 font-mono text-small">{label}</span>}
        <span className="text-small text-studio-muted">{new Date(row.result.created_at).toLocaleString()}</span>
        <div className="ml-auto flex flex-wrap items-center gap-1">
          {done && source?.media_url && (
            <Button variant="ghost" size="sm" aria-pressed={compare} onClick={() => setCompare((c) => !c)}>
              {compare ? <Columns2 aria-hidden /> : <SplitSquareHorizontal aria-hidden />}
              {compare ? 'Side by side' : row.kind === 'video' ? 'Synced compare' : 'Compare slider'}
            </Button>
          )}
          {library && (
            <Button asChild variant="ghost" size="sm">
              <Link to={library}>
                <ExternalLink aria-hidden />
                {row.media_id ? 'Open in Library' : 'Open project'}
              </Link>
            </Button>
          )}
          {onAgain && source?.media_url && (done || failed) && (
            <Button variant="ghost" size="sm" onClick={() => onAgain(source, row.title)}>
              <RefreshCw aria-hidden />
              Upscale again
            </Button>
          )}
          {row.result.status !== 'approved' && (
            <Button variant="ghost" size="sm" onClick={() => setConfirming(true)} loading={remove.isPending}>
              <Trash2 aria-hidden />
              {running ? 'Cancel' : 'Delete upscaled version'}
            </Button>
          )}
        </div>
      </header>

      {running && (
        <div className="flex flex-col gap-1" aria-live="polite">
          <Progress value={job?.status === 'running' ? job.progress : null} label="Upscale progress" />
          <p className="text-small text-studio-muted">
            {job?.status === 'running' ? `Upscaling · ${Math.round((job.progress ?? 0) * 100)}%` : job?.message || 'Waiting for the GPU…'}
          </p>
        </div>
      )}
      {failed && (
        <p role="alert" className="flex items-center gap-2 text-body text-studio-danger">
          <AlertTriangle aria-hidden className="size-4" />
          {row.error || job?.error || 'The upscale failed.'}
        </p>
      )}
      {remove.error && <ErrorState compact title="Couldn't delete it" error={remove.error} />}

      {compare && done && source?.media_url && row.result.media_url ? (
        <BeforeAfter
          kind={row.kind}
          before={source.media_url}
          after={row.result.media_url}
          alt={`${row.title}, original and upscaled`}
          beforeLabel="Original"
          afterLabel={`Upscaled · ${label}`}
          aspectClass="aspect-video"
        />
      ) : (
        <div className="flex flex-col gap-3 md:flex-row">
          <Panel gen={source} title="Original" kind={row.kind} size={sizeOf(source)} />
          <Panel gen={row.result} title="Upscaled" kind={row.kind} size={row.width && row.height ? `${row.width}×${row.height}` : sizeOf(row.result)} />
        </div>
      )}

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={running ? 'Cancel this upscale?' : 'Delete the upscaled version?'}
        description="The original stays exactly as it is; only the bigger copy goes."
        confirmLabel={running ? 'Cancel upscale' : 'Delete upscaled version'}
        tone="danger"
        onConfirm={() => remove.mutate(row.result.id, { onSuccess: () => announce(`Deleted the upscaled version of ${row.title}.`) })}
      />
    </article>
  )
}

// shown the moment a job is queued, until the server's list has it
function QueuedCard({ entry }: { entry: UpscaleEntry }) {
  const job = useJob(entry.jobId)
  return (
    <article className="flex flex-col gap-2 rounded-[6px] border border-studio-border-strong bg-studio-panel p-3 shadow-card" aria-label={`Upscale: ${entry.label}`}>
      <h3 className="font-display text-panel font-semibold">{entry.label}</h3>
      <Progress value={job?.status === 'running' ? job.progress : null} label="Upscale progress" />
      <p className="text-small text-studio-muted">{job?.message || 'Queued…'}</p>
    </article>
  )
}

interface Props {
  kind: MediaKind
  // what this browser just queued; dropped as soon as the server lists it
  pending?: UpscaleEntry[]
  onSeen?: (resultIds: string[]) => void
  onAgain?: (source: Generation, title: string) => void
}

/** "Your upscales": every upscale in the workspace, from the server, newest first. */
export function UpscaleResults({ kind, pending = [], onSeen, onAgain }: Props) {
  const list = useUpscaleList(kind)
  const [all, setAll] = useState(false)
  const rows = list.data?.pages.flatMap((p) => p.items ?? []) ?? []
  const known = new Set(rows.map((r) => r.result.id))
  const local = pending.filter((e) => !known.has(e.resultId))
  const seen = list.data ? pending.filter((e) => known.has(e.resultId)).map((e) => e.resultId) : []
  const seenKey = seen.join(',')

  useEffect(() => {
    if (seenKey) onSeen?.(seenKey.split(','))
  }, [seenKey, onSeen])

  if (list.isError && !local.length) {
    return <ErrorState compact title="Couldn't load your upscales" error={list.error} onRetry={() => list.refetch()} />
  }
  const total = local.length + rows.length
  if (total === 0) return null
  const room = all ? Infinity : Math.max(0, COLLAPSED - local.length)
  const visible = rows.slice(0, room)

  return (
    <section aria-labelledby="upscale-results" className="flex flex-col gap-3">
      <h2 id="upscale-results" className="section-label">
        Your upscales
      </h2>
      {local.map((e) => (
        <QueuedCard key={e.resultId} entry={e} />
      ))}
      {visible.map((r) => (
        <ResultCard key={r.result.id} row={r} onAgain={onAgain} />
      ))}
      <div className="flex flex-wrap justify-center gap-2">
        {!all && (rows.length > visible.length || list.hasNextPage) && (
          <Button variant="secondary" onClick={() => setAll(true)}>
            Show all
          </Button>
        )}
        {all && list.hasNextPage && (
          <Button variant="secondary" loading={list.isFetchingNextPage} onClick={() => list.fetchNextPage()}>
            Load more
          </Button>
        )}
      </div>
    </section>
  )
}
