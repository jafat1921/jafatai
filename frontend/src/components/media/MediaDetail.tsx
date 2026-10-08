import { useState } from 'react'
import { Link } from 'react-router'
import { Download, ExternalLink, ImageIcon, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { ErrorState } from '@/components/studio/states'
import { StatusPill } from '@/components/studio/status-pill'
import { CompareToggle, ImageStage } from '@/components/review/ImageStage'
import { GenerationMedia } from '@/components/review/media'
import type { CompareMode } from '@/components/review/ZoomView'
import { useMediaItem } from '@/hooks/useMedia'
import { comparePartner } from '@/lib/imageUpscale'
import { downloadUrl, mediaAlt, versionRole } from '@/lib/media'
import { generationStatus, isPendingGeneration } from '@/lib/status'
import type { Generation, MediaDetail as Detail } from '@/lib/types'
import { cn, plural, timeAgo } from '@/lib/utils'

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[88px_1fr] gap-2 text-small">
      <dt className="text-studio-muted">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  )
}

const sizeOf = (g: Generation, item: Detail) => {
  const p = g.params ?? {}
  if (typeof p.width === 'number' && typeof p.height === 'number') return `${p.width}×${p.height}`
  return item.width && item.height && g.id === item.generation_id ? `${item.width}×${item.height}` : '—'
}

function Body({ item }: { item: Detail }) {
  const versions = [...(item.versions ?? [])].sort((a, b) => b.version - a.version)
  const [viewId, setViewId] = useState<string>()
  const [compareId, setCompareId] = useState<string>()
  const [mode, setMode] = useState<CompareMode>('off')
  const current = versions.find((v) => v.id === viewId) ?? versions.find((v) => v.id === item.generation_id) ?? versions[0]
  const name = mediaAlt(item)

  if (!current) {
    return <p className="p-4 text-body text-studio-muted">This item has no versions yet.</p>
  }
  const pending = isPendingGeneration(current.status)
  const still = !!current.media_url && !pending && item.kind === 'image'
  const viewable = (g: Generation) => !!g.media_url && !isPendingGeneration(g.status) && g.id !== current.id
  const partner = still ? (versions.find((v) => v.id === compareId && viewable(v)) ?? comparePartner(current, versions)) : undefined
  const editOf = (current.params?.edit_of ?? null) as string[] | string | null
  // the oldest version is what everything else was made from
  const rootId = item.original_generation_id ?? versions[versions.length - 1]?.id

  return (
    <div className="flex flex-col gap-4 p-4">
      <figure className={cn('darkroom relative w-full overflow-hidden rounded-[6px]', item.kind === 'video' ? 'aspect-video' : 'aspect-square')}>
        {still ? (
          <ImageStage current={current} partner={partner} subject={name} mode={mode} />
        ) : current.media_url && !pending ? (
          <GenerationMedia key={current.id} gen={{ ...current, media_type: item.kind === 'video' ? 'video/mp4' : current.media_type }} alt={`${name}, version ${current.version}`} />
        ) : (
          <div className="shimmer-dark flex size-full items-center justify-center text-studio-on-dark-muted">
            {pending ? <Loader2 aria-hidden className="size-6 motion-safe:animate-spin" /> : <ImageIcon aria-hidden className="size-6" />}
          </div>
        )}
        <figcaption className="absolute left-2 top-2">
          <StatusPill status={generationStatus(current.status)} className="bg-studio-raised/90" />
        </figcaption>
      </figure>

      {still && versions.filter(viewable).length > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          <CompareToggle mode={partner ? mode : 'off'} onChange={setMode} />
          <label className="flex items-center gap-2 text-small text-studio-muted">
            with
            <select
              className="h-7 rounded-[6px] border border-studio-border-strong bg-studio-raised px-2 text-small text-studio-text"
              value={partner?.id ?? ''}
              onChange={(e) => {
                setCompareId(e.target.value || undefined)
                if (e.target.value && mode === 'off') setMode('side')
              }}
            >
              <option value="">Choose a version</option>
              {versions.filter(viewable).map((v) => (
                <option key={v.id} value={v.id}>
                  Version {v.version}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      <section aria-label="Versions">
        <h3 className="section-label mb-2">Versions ({versions.length})</h3>
        <ol className="flex gap-2 overflow-x-auto pb-2">
          {versions.map((v) => (
            <li key={v.id} className="w-24 shrink-0">
              <button
                type="button"
                aria-pressed={v.id === current.id}
                aria-label={`Version ${v.version}, ${generationStatus(v.status).label}`}
                onClick={() => setViewId(v.id)}
                className={cn('w-full rounded-[6px] p-0.5', v.id === current.id && 'ring-2 ring-studio-accent')}
              >
                <span className="darkroom flex aspect-square items-center justify-center overflow-hidden rounded-[4px]">
                  {(v.thumb_url || v.media_url) && (item.kind === 'image' || v.thumb_url) ? (
                    <img src={v.thumb_url ?? v.media_url!} alt="" className="size-full object-cover" loading="lazy" decoding="async" />
                  ) : (
                    <span className="font-mono text-small">v{v.version}</span>
                  )}
                </span>
              </button>
              <span className="block text-center font-mono text-[11px] text-studio-muted">
                v{v.version}
                {v.id === item.generation_id ? ' · current' : ''}
              </span>
              <span className="block truncate text-center text-[11px]" title={versionRole(v, v.id === rootId)}>
                {versionRole(v, v.id === rootId)}
              </span>
              {v.media_url && !isPendingGeneration(v.status) && (
                <a
                  href={downloadUrl(v.id)}
                  download
                  className="mt-0.5 flex items-center justify-center gap-1 rounded-[4px] text-[11px] text-studio-accent-hover underline-offset-2 hover:underline"
                  aria-label={`Download version ${v.version} (${versionRole(v, v.id === rootId).toLowerCase()})`}
                >
                  <Download aria-hidden className="size-3" />
                  Download
                </a>
              )}
            </li>
          ))}
        </ol>
      </section>

      <dl className="flex flex-col gap-1.5 rounded-[6px] border border-studio-border bg-studio-raised p-3">
        <Meta label="Prompt">{current.prompt || <span className="text-studio-muted">—</span>}</Meta>
        {current.note && <Meta label="Note">{current.note}</Meta>}
        <Meta label="Seed">
          <span className="font-mono">{current.seed ?? '—'}</span>
        </Meta>
        <Meta label="Size">
          <span className="font-mono">{sizeOf(current, item)}</span>
        </Meta>
        {item.kind === 'video' && item.duration_s != null && (
          <Meta label="Length">
            <span className="font-mono">{Math.round(item.duration_s)} s</span>
          </Meta>
        )}
        {editOf && <Meta label="Edited from">{Array.isArray(editOf) ? `${editOf.length} reference${editOf.length === 1 ? '' : 's'}` : '1 reference'}</Meta>}
        <Meta label="Created">{timeAgo(current.created_at)}</Meta>
        {item.tags?.length > 0 && <Meta label="Tags">{item.tags.join(', ')}</Meta>}
      </dl>

      <div className="flex flex-wrap gap-2">
        {current.media_url && !pending && (
          <Button asChild variant="secondary">
            <a href={downloadUrl(current.id)} download>
              <Download aria-hidden />
              Download v{current.version}
            </a>
          </Button>
        )}
        {item.project_id && (
          <Button asChild variant="ghost">
            <Link to={`/projects/${item.project_id}/output`}>
              <ExternalLink aria-hidden />
              Open project
            </Link>
          </Button>
        )}
      </div>
    </div>
  )
}

/** Item detail: versions, compare, zoom and metadata. Opened from any library grid. */
export function MediaDetailSheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  const q = useMediaItem(id)
  return (
    <Sheet open={!!id} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-[min(760px,100vw)]" aria-describedby="media-detail-desc">
        <div className="border-b border-studio-border px-4 py-3.5 pr-12">
          <SheetTitle className="truncate font-display text-panel font-semibold">{q.data ? mediaAlt(q.data) : 'Loading…'}</SheetTitle>
          <SheetDescription id="media-detail-desc" className="text-small text-studio-muted">
            {q.data ? `${q.data.kind === 'video' ? 'Video' : 'Image'} · ${plural(Math.max(q.data.versions?.length ?? 0, q.data.versions_count || 1), 'version')}` : 'Details'}
          </SheetDescription>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          {q.isPending && <Skeleton className="m-4 aspect-square" />}
          {q.isError && <ErrorState className="m-4" error={q.error} onRetry={() => q.refetch()} />}
          {q.data && <Body key={q.data.id} item={q.data} />}
        </ScrollArea>
      </SheetContent>
    </Sheet>
  )
}
