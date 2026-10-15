import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { ArrowLeft, Download, ImagePlus, LayoutTemplate, Loader2, PenLine, Play, RefreshCw, Trash2 } from 'lucide-react'
import { ConfirmDialog } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Chip } from '@/components/studio/chip'
import { ErrorState } from '@/components/studio/states'
import { useAdCampaign, useContinueAds, useDeleteAds, useRegenerateConcept } from '@/hooks/useAds'
import { adsBusy, FORMATS, STATUS_LABEL, STYLES, zipUrl, type Ad, type AdCampaign, type AdFormat } from '@/lib/ads'
import { cn, plural } from '@/lib/utils'
import { announce } from '@/stores/ui'
import { AdEditor } from './AdEditor'
import { ConceptsBoard } from './ConceptsBoard'

const STAGE_STATUS: Record<string, string> = { pending: 'to do', running: 'working', review: 'needs your OK', done: 'done', skipped: 'skipped', failed: 'stopped' }

export function AdCampaignPage() {
  const { id = '' } = useParams()
  const q = useAdCampaign(id)
  if (q.isPending)
    return (
      <div className="flex flex-col gap-2 p-6">
        <Skeleton className="h-10" />
        <Skeleton className="h-64" />
      </div>
    )
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} className="m-6" />
  return <Campaign key={q.data.id} camp={q.data} />
}

function AdCard({ camp, ad, selected, onEdit, busy }: { camp: AdCampaign; ad: Ad; selected: boolean; onEdit: () => void; busy: boolean }) {
  const regen = useRegenerateConcept(camp.id)
  const concept = camp.concepts.find((c) => c.id === ad.concept_id)
  const fmt = FORMATS.find((f) => f.id === ad.format)
  const label = `Concept ${concept?.n ?? ''}, ${fmt?.label ?? ad.format}`
  const next = STYLES[(STYLES.findIndex((s) => s.id === (concept?.layout ?? 'frosted')) + 1) % STYLES.length]
  return (
    <li aria-label={label} className={cn('flex flex-col gap-2 rounded-[8px] border bg-studio-panel p-2 shadow-card', selected ? 'border-studio-accent' : 'border-studio-border-strong')}>
      <div className="flex items-center justify-center overflow-hidden rounded-[6px] bg-studio-raised" style={{ aspectRatio: `${ad.width} / ${ad.height}` }}>
        {ad.status === 'ready' && (ad.thumb_url || ad.image_url) ? (
          <img src={ad.thumb_url ?? ad.image_url ?? undefined} alt={`${label}: ${concept?.headline ?? ''}`} className="size-full object-contain" />
        ) : ad.status === 'failed' ? (
          <p role="alert" className="p-3 text-center text-small text-studio-danger">
            {ad.error ?? 'This ad could not be made'}
          </p>
        ) : (
          <Loader2 aria-label="Being made" className="size-6 animate-spin text-studio-muted" />
        )}
      </div>
      <div className="flex items-center gap-1 text-small text-studio-muted">
        <span className="truncate">{label}</span>
        {ad.version && <span className="ml-auto shrink-0">v{ad.version}</span>}
      </div>
      <div className="flex flex-wrap gap-1">
        <Button type="button" size="sm" variant={selected ? 'primary' : 'secondary'} onClick={onEdit} disabled={ad.status !== 'ready' || !ad.spec} aria-pressed={selected}>
          <PenLine aria-hidden />
          Edit
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy || regen.isPending} onClick={() => regen.mutate({ conceptId: ad.concept_id, what: 'layout' }, { onSuccess: () => announce(`Concept ${concept?.n} now uses ${next.label}.`) })}>
          <LayoutTemplate aria-hidden />
          Other layout
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy || regen.isPending} onClick={() => regen.mutate({ conceptId: ad.concept_id, what: 'photo' }, { onSuccess: () => announce(`Making a new photo for concept ${concept?.n}.`) })}>
          <ImagePlus aria-hidden />
          New photo
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy || regen.isPending} onClick={() => regen.mutate({ conceptId: ad.concept_id, what: 'copy' }, { onSuccess: () => announce(`Writing concept ${concept?.n} again.`) })}>
          <RefreshCw aria-hidden />
          New copy
        </Button>
      </div>
      {regen.isError && (
        <p role="alert" className="text-small text-studio-danger">
          {regen.error.message}
        </p>
      )}
    </li>
  )
}

function Campaign({ camp }: { camp: AdCampaign }) {
  const nav = useNavigate()
  const go = useContinueAds(camp.id)
  const remove = useDeleteAds()
  const busy = adsBusy(camp)
  const [format, setFormat] = useState<AdFormat | 'all'>('all')
  const [editing, setEditing] = useState<string | null>(null)
  const [confirm, setConfirm] = useState(false)
  const reviewing = camp.review === 'concepts'
  const approved = camp.concepts.filter((c) => c.approved).length
  const ads = camp.ads.filter((a) => format === 'all' || a.format === format)
  const editAd = camp.ads.find((a) => a.id === editing && a.spec)
  const newlyTicked = camp.status === 'done' && camp.concepts.some((c) => c.approved && !camp.ads.some((a) => a.concept_id === c.id))
  const failed = camp.stages.find((s) => s.status === 'failed')

  return (
    <main data-f6-region tabIndex={-1} aria-labelledby="ad-title" className="h-full overflow-y-auto focus-visible:outline-none">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-4 py-4 md:px-8">
        <header className="flex flex-wrap items-center gap-2">
          <Button asChild size="icon-sm" variant="ghost">
            <Link to="/image/ads" aria-label="All campaigns">
              <ArrowLeft aria-hidden />
            </Link>
          </Button>
          <h1 id="ad-title" dir="auto" className="font-display text-[20px] font-semibold">
            {camp.title || 'Ad campaign'}
          </h1>
          <span className="text-small text-studio-muted" aria-live="polite">
            {STATUS_LABEL[camp.status]}
            {busy && camp.job?.message ? ` · ${camp.job.message}` : ''}
          </span>
          <div className="ml-auto flex flex-wrap gap-2">
            {camp.zip_url && (
              <Button asChild variant="secondary" size="sm">
                <a href={zipUrl(camp.id)} download>
                  <Download aria-hidden />
                  Download all
                </a>
              </Button>
            )}
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setConfirm(true)}>
              <Trash2 aria-hidden />
              Delete
            </Button>
          </div>
        </header>

        <ol className="flex flex-wrap gap-2 text-small" aria-label="Steps">
          {camp.stages.map((s, i) => (
            <li key={s.key} className={cn('rounded-full border px-3 py-0.5', s.status === 'review' ? 'border-studio-accent bg-studio-accent-soft' : 'border-studio-border-strong bg-studio-raised')}>
              {i + 1}. {s.label}: {STAGE_STATUS[s.status] ?? s.status}
            </li>
          ))}
        </ol>

        {failed && (
          <div role="alert" className="flex flex-wrap items-center gap-2 rounded-[6px] border border-studio-danger/40 bg-studio-danger/5 p-3 text-small">
            <span>
              {failed.label} stopped{failed.detail ? `: ${failed.detail}` : ''}
            </span>
            <Button type="button" size="sm" variant="secondary" className="ml-auto" disabled={busy} loading={go.isPending} onClick={() => go.mutate()}>
              Try again
            </Button>
          </div>
        )}

        {camp.brand_kit && camp.brand_kit.missing_contact.length > 0 && (
          <p className="text-small text-studio-muted" role="note">
            The footer is missing your {camp.brand_kit.missing_contact.join(', ')}.{' '}
            <Link className="underline underline-offset-2" to={`/brand-kits/${camp.brand_kit.id}`}>
              Add them to {camp.brand_kit.name}
            </Link>
            , then re-save an ad to see them.
          </p>
        )}

        {camp.concepts.length === 0 && busy && (
          <p className="flex items-center gap-2 text-body text-studio-muted" role="status">
            <Loader2 aria-hidden className="size-4 animate-spin" />
            The creative director is writing your concepts…
          </p>
        )}

        {(reviewing || (camp.ads.length === 0 && camp.concepts.length > 0)) && (
          <section aria-labelledby="concepts-h" className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <h2 id="concepts-h" className="font-display text-title font-semibold">
                Concepts
              </h2>
              <span className="text-small text-studio-muted">Edit any line, untick the ones you don't want, then make the photos and ads.</span>
              <Button type="button" variant="primary" className="ml-auto" disabled={busy || approved === 0} loading={go.isPending} onClick={() => go.mutate(undefined, { onSuccess: () => announce('Making the photos and ads.') })}>
                <Play aria-hidden />
                Make {plural(approved, 'concept')}
              </Button>
            </div>
            <ConceptsBoard camp={camp} busy={busy} />
          </section>
        )}

        {camp.ads.length > 0 && (
          <section aria-labelledby="ads-results-h" className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <h2 id="ads-results-h" className="font-display text-title font-semibold">
                Your ads
              </h2>
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Show format">
                <Chip selected={format === 'all'} onClick={() => setFormat('all')}>
                  All
                </Chip>
                {FORMATS.filter((f) => camp.brief.formats.includes(f.id)).map((f) => (
                  <Chip key={f.id} selected={format === f.id} onClick={() => setFormat(f.id)}>
                    {f.label}
                  </Chip>
                ))}
              </div>
              {newlyTicked && (
                <Button type="button" size="sm" variant="primary" className="ml-auto" disabled={busy} loading={go.isPending} onClick={() => go.mutate()}>
                  Make the newly ticked concepts
                </Button>
              )}
            </div>
            <div className={cn('grid gap-4', editAd && 'lg:grid-cols-[minmax(0,1fr)_400px]')}>
              <ul className="grid content-start gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-label="Ads">
                {ads.map((a) => (
                  <AdCard key={a.id} camp={camp} ad={a} busy={busy} selected={a.id === editing} onEdit={() => setEditing(a.id === editing ? null : a.id)} />
                ))}
              </ul>
              {editAd && <AdEditor key={`${editAd.id}:${editAd.generation_id}`} camp={camp} ad={editAd} onClose={() => setEditing(null)} />}
            </div>
            {!reviewing && camp.concepts.length > 0 && (
              <details className="text-small">
                <summary className="cursor-pointer text-studio-muted">Concepts and their copy</summary>
                <div className="mt-2">
                  <ConceptsBoard camp={camp} busy={busy} />
                </div>
              </details>
            )}
          </section>
        )}

        <ConfirmDialog
          open={confirm}
          onOpenChange={setConfirm}
          title={`Delete “${camp.title || 'this campaign'}”?`}
          description="The finished ads stay in your Library."
          confirmLabel="Delete campaign"
          tone="danger"
          onConfirm={() =>
            remove.mutate(camp.id, {
              onSuccess: () => {
                announce('Campaign deleted.')
                nav('/image/ads')
              },
            })
          }
        />
      </div>
    </main>
  )
}
