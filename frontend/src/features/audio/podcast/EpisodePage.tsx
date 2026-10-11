import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from 'react-router'
import { ArrowLeft, ArrowRight, Check, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { ErrorState } from '@/components/studio/states'
import { qk } from '@/hooks/keys'
import { useEpisode, usePatchEpisode } from '@/hooks/usePodcast'
import { STEPS, stepStates, type Episode, type StepId } from '@/lib/podcast'
import { cn } from '@/lib/utils'
import { HostsStep } from './HostsStep'
import { ProduceStep } from './ProduceStep'
import { PublishStep } from './PublishStep'
import { ScriptStep } from './ScriptStep'
import { SourceStep } from './SourceStep'
import { VoiceStep } from './VoiceStep'

export function EpisodePage() {
  const { id = '' } = useParams()
  const q = useEpisode(id)
  if (q.isPending)
    return (
      <div className="flex flex-col gap-2 p-6">
        <Skeleton className="h-10" />
        <Skeleton className="h-64" />
      </div>
    )
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} className="m-6" />
  return <EpisodeEditor key={q.data.id} ep={q.data} />
}

function EpisodeEditor({ ep }: { ep: Episode }) {
  const patch = usePatchEpisode(ep.id)
  const qc = useQueryClient()
  const [step, setStep] = useState(() => Math.min(6, Math.max(1, ep.step || 1)))
  const states = stepStates(ep)
  const go = (n: number) => {
    const next = Math.min(6, Math.max(1, n))
    setStep(next)
    if (next !== ep.step) patch.mutate({ step: next })
  }

  // a finished write / edit changed the script under the editor
  const writeStatus = ep.jobs.write?.status
  const lastWrite = useRef(writeStatus)
  useEffect(() => {
    if (lastWrite.current !== writeStatus && writeStatus === 'done' && ep.script_id) qc.invalidateQueries({ queryKey: qk.script(ep.script_id) })
    lastWrite.current = writeStatus
  }, [writeStatus, ep.script_id, qc])

  const current = STEPS[step - 1]
  return (
    <main data-f6-region tabIndex={-1} aria-labelledby="episode-title" className="flex h-full min-h-0 flex-col focus-visible:outline-none">
      <header className="flex flex-wrap items-center gap-2 border-b border-studio-border bg-studio-panel px-3 py-2">
        <Button asChild size="icon-sm" variant="ghost">
          <Link to="/audio/podcast" aria-label="All episodes">
            <ArrowLeft aria-hidden />
          </Link>
        </Button>
        <h1 id="episode-title" className="sr-only">
          {ep.title}
        </h1>
        <TitleField title={ep.title} onSave={(title) => patch.mutate({ title })} />
        {ep.show_name && <span className="text-[11px] text-studio-muted">{ep.show_name}</span>}
        <span className="ml-auto text-[12px] text-studio-muted">
          {ep.words ? `${ep.words} words · ≈ ${ep.minutes} min` : `${ep.target_minutes} min planned`}
        </span>
      </header>
      <Stepper current={step} states={states} onPick={go} />
      <section
        role="tabpanel"
        id={`step-panel-${current.id}`}
        aria-labelledby={`step-tab-${current.id}`}
        tabIndex={-1}
        className="min-h-0 flex-1 overflow-y-auto focus-visible:outline-none"
      >
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-5 md:px-8">
          {current.id === 'source' && <SourceStep ep={ep} onNext={() => go(2)} onScript={() => go(3)} />}
          {current.id === 'hosts' && <HostsStep ep={ep} />}
          {current.id === 'script' && <ScriptStep ep={ep} />}
          {current.id === 'voice' && <VoiceStep ep={ep} />}
          {current.id === 'produce' && <ProduceStep ep={ep} />}
          {current.id === 'publish' && <PublishStep ep={ep} />}
          {patch.isError && (
            <p role="alert" className="text-small text-studio-danger">
              {patch.error.message}
            </p>
          )}
        </div>
      </section>
      <footer className="flex items-center gap-2 border-t border-studio-border bg-studio-panel px-3 py-2">
        <Button type="button" size="sm" variant="ghost" disabled={step === 1} onClick={() => go(step - 1)}>
          <ArrowLeft aria-hidden />
          Back
        </Button>
        <span className="text-[12px] text-studio-muted">
          Step {step} of {STEPS.length}: {current.label}
        </span>
        {step < STEPS.length && (
          <Button type="button" size="sm" variant="primary" className="ml-auto" onClick={() => go(step + 1)}>
            Next: {STEPS[step].label}
            <ArrowRight aria-hidden />
          </Button>
        )}
      </footer>
    </main>
  )
}

const STATE_TEXT = { done: 'done', todo: 'to do', busy: 'working' } as const

/** The six steps as tabs: arrow keys move between them (and open them), Home / End jump to the ends. */
export function Stepper({ current, states, onPick }: { current: number; states: Record<StepId, 'done' | 'todo' | 'busy'>; onPick: (n: number) => void }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const onKey = (e: React.KeyboardEvent, i: number) => {
    const to = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? STEPS.length - 1 : null
    if (to === null) return
    e.preventDefault()
    const n = (to + STEPS.length) % STEPS.length
    onPick(n + 1)
    refs.current[n]?.focus()
  }
  return (
    <nav aria-label="Episode steps" className="border-b border-studio-border bg-studio-raised px-2 py-1.5">
      <div role="tablist" aria-label="Steps" className="flex gap-1 overflow-x-auto">
        {STEPS.map((s, i) => {
          const on = s.n === current
          const st = states[s.id]
          return (
            <button
              key={s.id}
              ref={(el) => {
                refs.current[i] = el
              }}
              type="button"
              role="tab"
              id={`step-tab-${s.id}`}
              aria-selected={on}
              aria-controls={`step-panel-${s.id}`}
              tabIndex={on ? 0 : -1}
              onClick={() => onPick(s.n)}
              onKeyDown={(e) => onKey(e, i)}
              className={cn(
                'flex h-9 shrink-0 items-center gap-2 rounded-[6px] border px-3 text-small focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-studio-accent',
                on ? 'border-studio-accent bg-studio-accent-soft font-medium text-studio-text' : 'border-transparent text-studio-muted hover:bg-studio-panel-hover hover:text-studio-text',
              )}
            >
              <span
                aria-hidden
                className={cn(
                  'flex size-5 items-center justify-center rounded-full border text-[11px] [&_svg]:size-3',
                  st === 'done' ? 'border-studio-success bg-studio-success text-studio-accent-fg' : 'border-studio-border-strong',
                )}
              >
                {st === 'done' ? <Check /> : st === 'busy' ? <Loader2 className="animate-spin" /> : s.n}
              </span>
              {s.label}
              <span className="sr-only">, {STATE_TEXT[st]}</span>
            </button>
          )
        })}
      </div>
    </nav>
  )
}

function TitleField({ title, onSave }: { title: string; onSave: (t: string) => void }) {
  const [value, setValue] = useState(title)
  const [was, setWas] = useState(title)
  if (was !== title) {
    setWas(title)
    setValue(title)
  }
  const commit = () => {
    const t = value.trim()
    if (t && t !== title) onSave(t)
    else setValue(title)
  }
  return (
    <Input
      aria-label="Episode title"
      value={value}
      maxLength={200}
      dir="auto"
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      className="h-8 w-64 border-transparent bg-transparent font-display text-[18px] font-semibold hover:border-studio-border"
    />
  )
}
