import { useState } from 'react'
import { Link } from 'react-router'
import { Film } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Chip } from '@/components/studio/chip'
import { EmptyState, ErrorState } from '@/components/studio/states'
import { DownloadButton } from '@/features/reel/ReelRenders'
import { ComparePlayer } from '@/features/upscale/ComparePlayer'
import { UpscaleDialog } from '@/features/upscale/UpscaleDialog'
import { useProjectId } from '@/features/workspace/selection'
import { useBreakpoint } from '@/hooks/useBreakpoint'
import { useGenerationActions } from '@/hooks/useGenerations'
import { useRenameRender, useRenders } from '@/hooks/useReel'
import { useProject } from '@/hooks/useProjects'
import { aspectClassFor } from '@/lib/aspect'
import { formatTimecode } from '@/lib/duration'
import { filterRenders, renderInfo, shortDate, type OutputFilter } from '@/lib/stitch'
import type { Render } from '@/lib/types'
import { compareSources, resolutionLabel, upscaleInfo } from '@/lib/upscale'
import { modelUsedId } from '@/lib/models'
import { Lightbox, type LightboxEntry } from '@/components/generate/Lightbox'
import { cn, plural } from '@/lib/utils'
import { announce } from '@/stores/ui'
import { OutputCard } from './OutputCard'

function renderEntry(r: Render): LightboxEntry {
  const info = renderInfo(r)
  return {
    key: r.id,
    kind: 'video',
    src: r.media_url ?? null,
    title: `${info.title} · v${r.version}`,
    prompt: [info.range, info.durationS != null ? formatTimecode(info.durationS) : null].filter(Boolean).join(' · '),
    modelId: modelUsedId(r.params),
    seed: r.seed,
    size: resolutionLabel(r),
    brandKitId: typeof r.params?.brand_kit_id === 'string' ? r.params.brand_kit_id : null,
    createdAt: r.created_at,
    generationId: r.id,
  }
}

const FILTERS: { value: OutputFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'full', label: 'Full film' },
  { value: 'partial', label: 'Partial' },
]

// TODO: EDL/XML export lands here once the Reel exposes clip timecodes.
export function OutputCanvas() {
  const projectId = useProjectId()
  const renders = useRenders(projectId)
  const project = useProject(projectId).data
  const aspect = aspectClassFor(project?.aspect_ratio)
  const reviewOnly = useBreakpoint() === 'mobile'
  const actions = useGenerationActions()
  const rename = useRenameRender(projectId)
  const [filter, setFilter] = useState<OutputFilter>('all')
  const [showRejected, setShowRejected] = useState(false)
  const [playingId, setPlayingId] = useState<string>()
  const [comparingId, setComparingId] = useState<string>()
  const [upscaleId, setUpscaleId] = useState<string>()

  const all = renders.data ?? []
  const final = all.find((r) => r.status === 'approved')
  const visible = filterRenders(all, filter, showRejected && !reviewOnly)
  const playable = visible.filter((r) => !!r.media_url && (r.status === 'ready' || r.status === 'approved'))
  const playIndex = playable.findIndex((r) => r.id === playingId)
  const playing = all.find((r) => r.id === comparingId)
  const playingInfo = playing && renderInfo(playing)
  const byId = new Map(all.map((r) => [r.id, r]))
  const sourceOf = (r: Render) => {
    const id = upscaleInfo(r)?.sourceId
    return id ? byId.get(id) : undefined
  }
  const busy = actions.approve.isPending || actions.unapprove.isPending || actions.reject.isPending || actions.restore.isPending
  const err = [actions.approve, actions.unapprove, actions.reject, actions.restore, rename].find((m) => m.isError)?.error

  const handlers = (r: Render) => {
    const title = renderInfo(r).title
    return {
      onPlay: () => setPlayingId(r.id),
      onApprove: () => actions.approve.mutate(r.id, { onSuccess: () => announce(`${title} is now the final film.`) }),
      onUnapprove: () => actions.unapprove.mutate(r.id),
      onReject: () => actions.reject.mutate(r.id, { onSuccess: () => announce(`${title} rejected.`) }),
      onRestore: () => actions.restore.mutate(r.id),
      onRename: (t: string) => rename.mutate({ id: r.id, title: t }, { onSuccess: () => announce(`Renamed to ${t}.`) }),
      onUpscale: () => setUpscaleId(r.id),
    }
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-col gap-2 px-5 pb-3 pt-4">
        <div>
          <h1 className="text-title font-display font-semibold">Output</h1>
          <p className="text-small text-studio-muted">
            {final
              ? `Final film: “${renderInfo(final).title}” v${final.version}, approved ${shortDate(final.approved_at ?? final.created_at)}`
              : all.length
                ? 'Approve a stitched video to mark it as the final film.'
                : 'Every video you stitch in the Reel lands here.'}
          </p>
        </div>
        {all.length > 0 && (
          <div className="flex flex-wrap items-center gap-3">
            <div role="group" aria-label="Show" className="flex flex-wrap gap-1">
              {FILTERS.map((f) => (
                <Chip key={f.value} selected={filter === f.value} onClick={() => setFilter(f.value)}>
                  {f.label}
                </Chip>
              ))}
            </div>
            {!reviewOnly && (
              <label className="flex items-center gap-2 text-small text-studio-muted">
                <Switch checked={showRejected} onCheckedChange={setShowRejected} aria-label="Show rejected" />
                Show rejected
              </label>
            )}
          </div>
        )}
      </header>

      <div className="@container min-h-0 flex-1 overflow-y-auto px-5 pb-8">
        {err && <ErrorState compact className="mb-3" title="That didn't work" error={err} />}
        {renders.isPending ? (
          <Skeleton className={cn('w-full max-w-md', aspect)} />
        ) : renders.isError ? (
          <ErrorState title="Couldn't load stitched videos" error={renders.error} onRetry={() => renders.refetch()} />
        ) : !all.length ? (
          <EmptyState
            icon={<Film />}
            title="Nothing stitched yet"
            action={
              <Button asChild variant="primary">
                <Link to={`/projects/${projectId}/reel`}>Go to Reel</Link>
              </Button>
            }
          >
            In the Reel, choose a range of scenes (or the whole film) and press Stitch video. Each result shows up here to
            play, approve and download.
          </EmptyState>
        ) : !visible.length ? (
          <p className="py-8 text-center text-body text-studio-muted">No {filter === 'full' ? 'full-film' : 'partial'} videos yet.</p>
        ) : (
          <ul aria-label={`Stitched videos, ${plural(visible.length, 'video')}`} className="grid gap-4 @xl:grid-cols-2 @4xl:grid-cols-3">
            {visible.map((r) => (
              <li key={r.id}>
                <OutputCard
                  render={r}
                  aspectClass={aspect}
                  reviewOnly={reviewOnly}
                  busy={busy}
                  sourceVersion={sourceOf(r)?.version}
                  {...handlers(r)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      <Lightbox
        entries={playable.map(renderEntry)}
        index={playIndex >= 0 ? playIndex : null}
        onIndex={(i) => setPlayingId(playable[i]?.id)}
        onClose={() => setPlayingId(undefined)}
        detailsLabel="Compare and approve"
        actions={{
          upscale: reviewOnly ? undefined : (e) => {
            setPlayingId(undefined)
            setUpscaleId(e.key)
          },
          details: (e) => {
            setPlayingId(undefined)
            setComparingId(e.key)
          },
        }}
      />
      <Dialog open={!!playing} onOpenChange={(open) => !open && setComparingId(undefined)}>
        {playing && playingInfo && (
          <DialogContent className="max-w-5xl">
            <DialogTitle className="pr-8">{playingInfo.title}</DialogTitle>
            <DialogDescription>
              {[playingInfo.range, playingInfo.durationS != null ? formatTimecode(playingInfo.durationS) : null, `v${playing.version}`]
                .filter(Boolean)
                .join(' · ')}
            </DialogDescription>
            <div className="mt-3">
              <ComparePlayer key={playing.id} sources={compareSources(playing, all, sourceOf(playing))} aspectClass={aspect} title={playingInfo.title} />
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <DownloadButton render={playing} size="md" />
              {playing.status === 'ready' && (
                <Button variant="primary" onClick={handlers(playing).onApprove} disabled={busy}>
                  Approve as final
                </Button>
              )}
            </div>
          </DialogContent>
        )}
      </Dialog>
      <UpscaleDialog
        render={all.find((r) => r.id === upscaleId) ?? null}
        projectId={projectId}
        aspectRatio={project?.aspect_ratio}
        onOpenChange={(open) => !open && setUpscaleId(undefined)}
      />
    </div>
  )
}
