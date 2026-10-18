import { useId, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { ArrowLeft, Download, FileDown, ImagePlus, Loader2, PenLine, Play, Scaling, Trash2 } from 'lucide-react'
import { ConfirmDialog } from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { ErrorState } from '@/components/studio/states'
import { useContinuePrint, useDeletePrint, useMakeFiles, usePrintJob, useRegeneratePicture, useResize } from '@/hooks/usePrint'
import {
  FAMILY_LABEL,
  FORMAT_LABEL,
  LAYOUTS,
  megabytes,
  PRESETS,
  printBusy,
  sizeLabel,
  STATUS_LABEL,
  tooBig,
  type FileFormat,
  type PrintDesign,
  type PrintJob,
  type PrintJobType,
} from '@/lib/print'
import { cn, plural } from '@/lib/utils'
import { announce } from '@/stores/ui'
import { DesignEditor } from './DesignEditor'

const STAGE_STATUS: Record<string, string> = { pending: 'to do', running: 'working', review: 'needs your OK', done: 'done', skipped: 'skipped', failed: 'stopped' }
const FORMATS: FileFormat[] = ['pdf', 'png', 'jpg', 'svg', 'zip']

export function PrintJobPage() {
  const { id = '' } = useParams()
  const q = usePrintJob(id)
  if (q.isPending)
    return (
      <div className="flex flex-col gap-2 p-6">
        <Skeleton className="h-10" />
        <Skeleton className="h-64" />
      </div>
    )
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} className="m-6" />
  return <Job key={q.data.id} job={q.data} />
}

const layoutLabel = (job: PrintJob, id?: string) => LAYOUTS[job.size.family].find((l) => l.id === id)?.label ?? id ?? ''

function Downloads({ job, design }: { job: PrintJob; design: PrintDesign }) {
  const files = useMakeFiles(job.id)
  const busy = printBusy(job)
  const ready = design.files.status === 'ready'
  return (
    <section aria-label={`Download option ${design.n}`} className="flex min-w-0 flex-col gap-2 rounded-[8px] border border-studio-border bg-studio-raised p-3">
      <h3 className="font-display text-body font-semibold">Download</h3>
      {ready ? (
        <ul className="grid min-w-0 gap-1.5 sm:grid-cols-2">
          {FORMATS.map((fmt) => {
            const f = design.files.files[fmt]
            if (!f) return null
            return (
              <li key={fmt} className="min-w-0">
                <a
                  href={f.url}
                  download
                  className="flex min-w-0 items-center gap-2 rounded-[6px] border border-studio-border-strong bg-studio-panel px-2.5 py-1.5 text-body hover:bg-studio-panel-hover focus-visible:outline-2 focus-visible:outline-studio-accent"
                >
                  <FileDown aria-hidden className="size-4 shrink-0 text-studio-accent" />
                  <span className="min-w-0 flex-1 truncate">{FORMAT_LABEL[fmt]}</span>
                  <span className="shrink-0 text-small text-studio-muted">{megabytes(f.bytes)}</span>
                </a>
              </li>
            )
          })}
        </ul>
      ) : (
        <>
          <p className="text-small text-studio-muted">
            {design.files.status === 'stale'
              ? 'You changed this design since its files were made; make them again for the new version.'
              : `PDF with bleed and crop marks, PNG and JPG at ${job.size.dpi} dpi, an editable SVG and the layers as PNGs.`}
          </p>
          <div>
            <Button
              type="button"
              variant="primary"
              size="sm"
              loading={files.isPending}
              disabled={busy}
              onClick={() => files.mutate([design.id], { onSuccess: () => announce('Making the print files. They appear here when ready.') })}
            >
              {busy ? <Loader2 aria-hidden className="animate-spin" /> : <Download aria-hidden />}
              {busy ? 'Working…' : 'Make the print files'}
            </Button>
          </div>
        </>
      )}
      {files.isError && (
        <p role="alert" className="text-small text-studio-danger">
          {files.error.message}
        </p>
      )}
    </section>
  )
}

function AnotherSize({ job, design }: { job: PrintJob; design: PrintDesign }) {
  const uid = useId()
  const nav = useNavigate()
  const resize = useResize(job.id)
  const [w, setW] = useState(String(job.size.height_cm))
  const [h, setH] = useState(String(job.size.width_cm))
  const [kind, setKind] = useState<PrintJobType>(job.brief.job)
  const wn = Number(w.replace(',', '.'))
  const hn = Number(h.replace(',', '.'))
  const ok = wn >= 3 && hn >= 3 && wn <= 500 && hn <= 500
  const dpi = job.brief.job === kind ? job.size.dpi : kind === 'flyer' || kind === 'sticker' ? 300 : 150
  return (
    <form
      aria-labelledby={`${uid}-h`}
      className="flex min-w-0 flex-col gap-2 rounded-[8px] border border-studio-border bg-studio-raised p-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (!ok) return
        resize.mutate(
          { designId: design.id, width_cm: wn, height_cm: hn, job: kind },
          {
            onSuccess: (j) => {
              announce('Making the same design at the new size.')
              nav(`/admin/print/${j.id}`)
            },
          },
        )
      }}
    >
      <h3 id={`${uid}-h`} className="font-display text-body font-semibold">
        Make another size
      </h3>
      <p className="text-small text-studio-muted">The same copy, colours and picture, laid out again for the new shape.</p>
      <div className="flex flex-wrap gap-1.5">
        {PRESETS.filter((p) => !p.shape).map((p) => (
          <button
            key={p.id}
            type="button"
            className={cn(
              'h-7 rounded-[6px] border px-2 text-small focus-visible:outline-2 focus-visible:outline-studio-accent',
              Number(w) === p.width_cm && Number(h) === p.height_cm ? 'border-studio-accent bg-studio-accent-soft' : 'border-studio-border-strong bg-studio-panel text-studio-muted hover:text-studio-text',
            )}
            aria-pressed={Number(w) === p.width_cm && Number(h) === p.height_cm}
            onClick={() => {
              setW(String(p.width_cm))
              setH(String(p.height_cm))
              setKind(p.job)
            }}
          >
            {p.label}
          </button>
        ))}
      </div>
      <div className="grid min-w-0 grid-cols-2 gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <Label htmlFor={`${uid}-w`}>Width (cm)</Label>
          <Input id={`${uid}-w`} inputMode="decimal" value={w} onChange={(e) => setW(e.target.value)} />
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <Label htmlFor={`${uid}-hh`}>Height (cm)</Label>
          <Input id={`${uid}-hh`} inputMode="decimal" value={h} onChange={(e) => setH(e.target.value)} />
        </div>
      </div>
      <p aria-live="polite" className="text-small text-studio-muted">
        {ok ? (tooBig(wn, hn, dpi) ? 'Too large at this resolution; the print job will ask for less.' : sizeLabel(wn, hn, dpi)) : 'Sizes from 3 to 500 cm.'}
      </p>
      <div>
        <Button type="submit" size="sm" disabled={!ok} loading={resize.isPending}>
          <Scaling aria-hidden />
          Make it
        </Button>
      </div>
      {resize.isError && (
        <p role="alert" className="text-small text-studio-danger">
          {resize.error.message}
        </p>
      )}
    </form>
  )
}

function OptionCard({ job, design, selected, onEdit }: { job: PrintJob; design: PrintDesign; selected: boolean; onEdit: () => void }) {
  const concept = job.concepts.find((c) => c.id === design.concept_id)
  const regen = useRegeneratePicture(job.id)
  const label = `Option ${design.n ?? ''}`
  const r = design.report
  const ok = !!r.min_text?.pass && !!r.all_pass
  const busy = printBusy(job)
  return (
    <li aria-label={label} className={cn('flex min-w-0 flex-col gap-2 rounded-[8px] border bg-studio-panel p-2 shadow-card', selected ? 'border-studio-accent' : 'border-studio-border-strong')}>
      <div className="flex items-center justify-center overflow-hidden rounded-[6px] bg-studio-raised" style={{ aspectRatio: `${job.size.px[0]} / ${job.size.px[1]}`, maxHeight: 420 }}>
        {design.status === 'ready' && (design.thumb_url || design.image_url) ? (
          <img src={design.image_url ?? design.thumb_url ?? undefined} alt={`${label}: ${concept?.headline || job.brief.lines.name}`} className="size-full object-contain" />
        ) : design.status === 'failed' ? (
          <p role="alert" className="p-3 text-center text-small text-studio-danger">
            {design.error ?? 'This option could not be made'}
          </p>
        ) : (
          <Loader2 aria-label="Being made" className="size-6 animate-spin text-studio-muted" />
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-body font-medium">{label}</span>
          {concept && <Badge tone="neutral">{FAMILY_LABEL[concept.family]}</Badge>}
          {design.version && <span className="ml-auto shrink-0 text-small text-studio-muted">v{design.version}</span>}
        </div>
        <span className="truncate text-small text-studio-muted">{layoutLabel(job, r.layout)}</span>
        <span className="text-small text-studio-muted">{job.size.label}</span>
        {design.status === 'ready' && (
          <span className={cn('text-small', ok ? 'text-studio-success' : 'text-studio-warning')}>{ok ? 'Passes the print checks' : 'Check the print checks'}</span>
        )}
      </div>
      <div className="flex flex-wrap gap-1">
        <Button type="button" size="sm" variant={selected ? 'primary' : 'secondary'} onClick={onEdit} disabled={design.status !== 'ready' || !design.spec} aria-pressed={selected}>
          <PenLine aria-hidden />
          Edit and download
        </Button>
        {concept && concept.family !== 'typographic' && (
          <Button type="button" size="sm" variant="ghost" disabled={busy} loading={regen.isPending} onClick={() => regen.mutate({ conceptId: concept.id, what: 'picture' })}>
            <ImagePlus aria-hidden />
            New picture
          </Button>
        )}
      </div>
    </li>
  )
}

function Job({ job }: { job: PrintJob }) {
  const nav = useNavigate()
  const go = useContinuePrint(job.id)
  const del = useDeletePrint()
  const [selected, setSelected] = useState<string | null>(null)
  const [confirm, setConfirm] = useState(false)
  const busy = printBusy(job)
  const sel = job.designs.find((d) => d.id === selected && d.status === 'ready' && d.spec)
  const failed = job.status === 'failed'
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6 md:px-8">
      <div className="flex min-w-0 flex-wrap items-start gap-3">
        <Button asChild variant="ghost" size="sm">
          <Link to="/admin/print">
            <ArrowLeft aria-hidden />
            Print Studio
          </Link>
        </Button>
        {/* on a phone the title takes its own row under the back and delete buttons */}
        <div className="order-last min-w-0 basis-full sm:order-none sm:basis-auto sm:flex-1">
          <h1 dir="auto" lang={job.language} className="break-words font-display text-title font-semibold">
            {job.title}
          </h1>
          <p className="text-small text-studio-muted">
            {STATUS_LABEL[job.status]} · {job.size.label} · {plural(job.designs.length, 'option')}
          </p>
        </div>
        <Button type="button" variant="ghost" size="sm" className="ml-auto sm:ml-0" disabled={busy} onClick={() => setConfirm(true)}>
          <Trash2 aria-hidden />
          Delete
        </Button>
      </div>

      <ol aria-label="Stages" className="flex min-w-0 flex-wrap gap-x-4 gap-y-1 text-small">
        {job.stages.map((s) => (
          <li key={s.key} className={cn(s.status === 'failed' ? 'text-studio-danger' : s.status === 'done' ? 'text-studio-text' : 'text-studio-muted')}>
            {s.label}: {STAGE_STATUS[s.status] ?? s.status}
            {s.status === 'running' && <Loader2 aria-hidden className="ml-1 inline size-3 animate-spin" />}
          </li>
        ))}
      </ol>
      {job.job?.message && busy && (
        <p aria-live="polite" className="text-small text-studio-muted">
          {job.job.message}
        </p>
      )}
      {(failed || job.status === 'review') && (
        <div role={failed ? 'alert' : undefined} className="flex min-w-0 flex-wrap items-center gap-2 rounded-[6px] border border-studio-border-strong bg-studio-raised p-2.5 text-small">
          <span className="min-w-0 flex-1">{failed ? (job.stages.find((s) => s.status === 'failed')?.detail ?? 'A stage stopped.') : 'Look over the options, then carry on.'}</span>
          <Button type="button" size="sm" variant="primary" loading={go.isPending} onClick={() => go.mutate()}>
            <Play aria-hidden />
            {failed ? 'Try again' : 'Continue'}
          </Button>
        </div>
      )}

      {job.designs.length > 0 && (
        <ul aria-label="Design options" className="grid min-w-0 grid-cols-[repeat(auto-fill,minmax(min(100%,220px),1fr))] gap-3">
          {job.designs.map((d) => (
            <OptionCard key={d.id} job={job} design={d} selected={d.id === sel?.id} onEdit={() => setSelected(d.id === selected ? null : d.id)} />
          ))}
        </ul>
      )}

      {sel && (
        <section aria-labelledby="print-edit-h" className="flex min-w-0 flex-col gap-3 rounded-[8px] border border-studio-border bg-studio-panel p-3 shadow-card md:p-4">
          <h2 id="print-edit-h" className="font-display text-title font-semibold">
            Option {sel.n}
          </h2>
          <DesignEditor job={job} design={sel} />
          <div className="grid min-w-0 gap-3 md:grid-cols-2">
            <Downloads job={job} design={sel} />
            <AnotherSize job={job} design={sel} />
          </div>
        </section>
      )}

      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Delete this print job?"
        description="The previews stay in your library; the job, its options and the print files' links go."
        confirmLabel="Delete"
        tone="danger"
        onConfirm={() => del.mutate(job.id, { onSuccess: () => nav('/admin/print') })}
      />
    </div>
  )
}
