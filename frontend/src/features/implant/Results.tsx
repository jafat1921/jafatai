import { useId, useState } from 'react'
import { Check, FileDown, ImageIcon, RotateCcw, Sparkles } from 'lucide-react'
import { BeforeAfter } from '@/components/media/BeforeAfter'
import { EmptyState } from '@/components/studio/states'
import { StatusPill } from '@/components/studio/status-pill'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { useApproveOption, useRetryPicture } from '@/hooks/useImplant'
import { ENGINE_LABEL, ENGINES, engineOf, implantApi, isDone, isPending, LETTERS, optionLine, patientViews, shortDay, VIEW_LABEL, type Engine, type ImplantSession, type Patient, type View } from '@/lib/implant'
import { generationStatus } from '@/lib/status'
import { announce } from '@/stores/ui'

interface Compare {
  before: string
  after: string
  title: string
  afterLabel: string
}

export function Results({ patient }: { patient: Patient }) {
  const [compare, setCompare] = useState<Compare | null>(null)
  return (
    <section aria-labelledby="implant-results-h" className="flex min-w-0 flex-col gap-3">
      <h2 id="implant-results-h" className="font-display text-title font-semibold">
        Results
      </h2>
      {patient.sessions.length === 0 ? (
        <EmptyState
          icon={<Sparkles />}
          title="Nothing rendered yet"
          action={
            <Button asChild size="sm" variant="secondary">
              <a href="#implant-options">Go to the options</a>
            </Button>
          }
        >
          Set up one to three options above, then render them.
        </EmptyState>
      ) : (
        patient.sessions.map((s) => <Consultation key={s.id} patient={patient} session={s} onCompare={setCompare} />)
      )}
      <Dialog open={!!compare} onOpenChange={(v) => !v && setCompare(null)}>
        <DialogContent className="max-w-3xl" aria-describedby="implant-compare-desc">
          <DialogHeader>
            <DialogTitle>{compare?.title}</DialogTitle>
            <DialogDescription id="implant-compare-desc">Drag the divider, or focus it and use the arrow keys.</DialogDescription>
          </DialogHeader>
          {compare && (
            <BeforeAfter before={compare.before} after={compare.after} alt={compare.title} beforeLabel="Photo" afterLabel={compare.afterLabel} aspectClass="aspect-[3/4] max-h-[70vh]" />
          )}
        </DialogContent>
      </Dialog>
    </section>
  )
}

function Consultation({ patient, session, onCompare }: { patient: Patient; session: ImplantSession; onCompare: (c: Compare) => void }) {
  const uid = useId()
  const retry = useRetryPicture(patient.id)
  const views = patientViews(patient).filter((v) => session.results.some((r) => r.view === v))
  // one row per view and way of showing it, when the AI edit and the shape warp were both made
  const engines = ENGINES.filter((e) => session.results.some((r) => engineOf(r) === e))
  const tagged = engines.length > 1
  const rows = views.flatMap((v) => engines.map((e) => ({ v, e })))
  const at = (v: View, i: number, e: Engine) => session.results.find((r) => r.view === v && r.option === i && engineOf(r) === e)
  const cols = { gridTemplateColumns: `repeat(${session.options.length + 1}, minmax(120px, 1fr))` }
  const chosen = patient.chart.session_id === session.id ? { option: patient.chart.option, engine: patient.chart.engine ?? 'ai' } : null

  return (
    <article aria-labelledby={`${uid}-h`} className="flex min-w-0 flex-col gap-3 rounded-[6px] border border-studio-border-strong bg-studio-panel p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 id={`${uid}-h`} className="mr-auto text-body font-medium">
          Consultation, {shortDay(session.created_at)}
        </h3>
        <Button asChild size="sm" variant="secondary">
          <a href={implantApi.consultationUrl(patient.id, session.id)} download>
            <FileDown aria-hidden />
            Download consultation PDF
          </a>
        </Button>
      </div>

      <div className="overflow-x-auto">
        <div role="table" aria-label={`Consultation, ${shortDay(session.created_at)}`} className="grid min-w-max gap-2" style={cols}>
          <div role="row" className="contents">
            <span role="columnheader" className="section-label">
              Photo
            </span>
            {session.options.map((o, i) => (
              <span key={i} role="columnheader" className="text-small">
                <span className="font-medium">Option {LETTERS[i]}</span>
                {o.label && ` · ${o.label}`}
                <span className="block text-studio-muted">{optionLine(o)}</span>
              </span>
            ))}
          </div>
          {rows.map(({ v, e }) => {
            const photo = patient.photos[v]
            const name = (patient.views?.[v] ?? VIEW_LABEL[v]) + (tagged ? ` · ${ENGINE_LABEL[e]}` : '')
            return (
              <div key={`${v}-${e}`} role="row" className="contents">
                <div role="rowheader" className="flex flex-col gap-1">
                  <Frame src={photo?.url} alt={`${name} photo`} />
                  <span className="text-small text-studio-muted">{name}</span>
                </div>
                {session.options.map((_, i) => {
                  const r = at(v, i, e)
                  const what = `Option ${LETTERS[i]}, ${name}`
                  return (
                    <div key={i} role="cell" className="flex flex-col gap-1">
                      {r && isDone(r) && r.url ? (
                        <button
                          type="button"
                          aria-label={`${what}: compare with the photo`}
                          className="rounded-[4px] focus-visible:outline-2 focus-visible:outline-studio-accent"
                          disabled={!photo?.url}
                          onClick={() => photo?.url && onCompare({ before: photo.url, after: r.url!, title: what, afterLabel: `Option ${LETTERS[i]}${tagged ? ` · ${ENGINE_LABEL[e]}` : ''}` })}
                        >
                          <Frame src={r.url} alt="" />
                        </button>
                      ) : (
                        <Frame src={null} alt={`${what}: not ready`} />
                      )}
                      {r && !isDone(r) && <StatusPill className="self-start" status={generationStatus(r.status)} />}
                      {r?.status === 'failed' && r.job_id && (
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          className="self-start"
                          aria-label={`Retry ${what}`}
                          loading={retry.isPending && retry.variables === r.job_id}
                          onClick={() => retry.mutate(r.job_id!)}
                        >
                          <RotateCcw aria-hidden />
                          Retry
                        </Button>
                      )}
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>
      </div>
      {retry.isError && (
        <p role="alert" className="text-small text-studio-danger">
          {retry.error.message}
        </p>
      )}

      <ul aria-label="Approve an option" className="flex flex-col gap-2">
        {session.options.flatMap((_, i) =>
          engines.map((e) => (
            <Approve key={`${i}-${e}`} patient={patient} session={session} option={i} engine={e} tagged={tagged} chosen={chosen?.option === i && chosen.engine === e} />
          )),
        )}
      </ul>
    </article>
  )
}

function Frame({ src, alt }: { src: string | null | undefined; alt: string }) {
  return (
    <span className="flex aspect-[3/4] w-full items-center justify-center overflow-hidden rounded-[4px] bg-studio-raised">
      {src ? (
        <img src={src} alt={alt} loading="lazy" className="size-full object-contain" />
      ) : (
        <>
          <ImageIcon aria-hidden className="size-5 text-studio-muted" />
          {alt && <span className="sr-only">{alt}</span>}
        </>
      )}
    </span>
  )
}

function Approve({ patient, session, option, engine, tagged, chosen }: { patient: Patient; session: ImplantSession; option: number; engine: Engine; tagged: boolean; chosen: boolean }) {
  const uid = useId()
  const approve = useApproveOption(patient.id)
  const [open, setOpen] = useState(false)
  const [notes, setNotes] = useState('')
  const mine = session.results.filter((r) => r.option === option && engineOf(r) === engine)
  const ready = mine.some(isDone)
  const letter = LETTERS[option] + (tagged ? ` (${ENGINE_LABEL[engine]})` : '')
  const why = ready ? null : mine.some(isPending) ? 'Its pictures are still being made.' : 'None of its pictures finished.'

  return (
    <li className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span aria-hidden className="min-w-24 text-small">
          <span className="font-medium">Option {letter}</span> · {session.options[option].left_cc} cc
        </span>
        <Button
          type="button"
          size="sm"
          variant={chosen ? 'secondary' : 'outline'}
          aria-expanded={open}
          aria-controls={`${uid}-form`}
          aria-describedby={why ? `${uid}-why` : undefined}
          disabled={!ready}
          onClick={() => setOpen((v) => !v)}
        >
          {chosen && <Check aria-hidden />}
          Approve this option…<span className="sr-only"> (option {letter})</span>
        </Button>
        {why && (
          <span id={`${uid}-why`} className="text-small text-studio-muted">
            {why}
          </span>
        )}
        {chosen && <span className="text-small text-studio-success">On the chart</span>}
      </div>
      {open && (
        <form
          id={`${uid}-form`}
          className="flex flex-col gap-1.5"
          onSubmit={(e) => {
            e.preventDefault()
            approve.mutate(
              { sessionId: session.id, option, engine, notes: notes.trim() },
              {
                onSuccess: () => {
                  announce(`Option ${letter} approved. The chart is ready to download.`)
                  setOpen(false)
                },
              },
            )
          }}
        >
          <label htmlFor={`${uid}-notes`} className="text-small">
            Surgeon’s notes for option {letter}
          </label>
          <Textarea id={`${uid}-notes`} rows={3} maxLength={1500} value={notes} onChange={(e) => setNotes(e.target.value)} autoFocus />
          {approve.isError && (
            <p role="alert" className="text-small text-studio-danger">
              {approve.error.message}
            </p>
          )}
          <Button type="submit" size="sm" variant="primary" className="self-start" loading={approve.isPending}>
            <Check aria-hidden />
            Approve and make the chart
          </Button>
        </form>
      )}
    </li>
  )
}
