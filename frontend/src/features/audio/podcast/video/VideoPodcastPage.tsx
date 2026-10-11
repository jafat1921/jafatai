import { useRef, useState } from 'react'
import { Link, useParams } from 'react-router'
import { ArrowLeft, ArrowRight, Check, Clapperboard, Loader2 } from 'lucide-react'
import { EmptyState, ErrorState } from '@/components/studio/states'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { StageTimeline } from '@/features/quick/StageTimeline'
import { useEpisode } from '@/hooks/usePodcast'
import { jobRunning, useAiVideo, useContinueAiVideo, useCreateAiVideo, useEpisodeAiVideo } from '@/hooks/useVideoPodcast'
import { busy, type Episode } from '@/lib/podcast'
import { formatEstimate } from '@/lib/shots'
import type { VideoPodcast } from '@/lib/types'
import { cn } from '@/lib/utils'
import { announce } from '@/stores/ui'
import { CamerasPanel } from './CamerasPanel'
import { HostsPanel } from './HostsPanel'
import { LookPanel } from './LookPanel'
import { RenderPanel } from './RenderPanel'
import { ResultPanel } from './ResultPanel'
import { SetPanel } from './SetPanel'
import { VP_STEPS, blockingStep, initialStep, stepStates, timelineStages, type VPStepState } from './vp'

export function VideoPodcastPage() {
  const { id = '' } = useParams()
  const ep = useEpisode(id)
  const ai = useEpisodeAiVideo(id)
  if (ep.isPending || ai.isPending)
    return (
      <div className="flex flex-col gap-2 p-6">
        <Skeleton className="h-10" />
        <Skeleton className="h-64" />
      </div>
    )
  if (ep.isError) return <ErrorState error={ep.error} onRetry={() => ep.refetch()} className="m-6" />
  if (ai.isError) return <ErrorState error={ai.error} onRetry={() => ai.refetch()} className="m-6" />
  if (!ai.data) return <StartView ep={ep.data} />
  return <Workspace key={ai.data.id} ep={ep.data} seed={ai.data} />
}

function BackLink({ ep }: { ep: Episode }) {
  return (
    <Button asChild size="sm" variant="ghost">
      <Link to={`/audio/podcast/${ep.id}`}>
        <ArrowLeft aria-hidden />
        <span>
          Back to the episode<span className="sr-only">: {ep.title}</span>
        </span>
      </Link>
    </Button>
  )
}

function StartView({ ep }: { ep: Episode }) {
  const create = useCreateAiVideo(ep.id)
  const why = !ep.outputs.mix ? 'Mix the episode first (Produce step).' : !ep.hosts.length ? 'Add the hosts first.' : null
  return (
    <main className="flex h-full min-h-0 flex-col overflow-y-auto">
      <header className="flex items-center gap-2 border-b border-studio-border bg-studio-panel px-3 py-2">
        <BackLink ep={ep} />
      </header>
      <EmptyState
        icon={<Clapperboard />}
        title={`AI video of ${ep.title}`}
        action={
          <Button type="button" variant="primary" aria-disabled={!!why || undefined} aria-describedby="vp-start-why" loading={create.isPending} onClick={() => !why && create.mutate({})}>
            Make an AI video
          </Button>
        }
      >
        The hosts on camera in a set, lip-synced to the episode mix and cut between angles.
      </EmptyState>
      <p id="vp-start-why" aria-live="polite" className="text-center text-small text-studio-muted">
        {why}
      </p>
      {create.isError && <ErrorState error={create.error} className="mx-auto max-w-md" />}
    </main>
  )
}

function Workspace({ ep, seed }: { ep: Episode; seed: VideoPodcast }) {
  const q = useAiVideo(seed.id)
  const vp = q.data ?? seed
  const [step, setStep] = useState(() => initialStep(seed))
  const states = stepStates(vp)
  const current = VP_STEPS[step - 1]
  const go = (n: number) => setStep(Math.min(VP_STEPS.length, Math.max(1, n)))

  return (
    <main data-f6-region tabIndex={-1} aria-labelledby="vp-title" className="flex h-full min-h-0 flex-col focus-visible:outline-none">
      <header className="flex flex-wrap items-center gap-2 border-b border-studio-border bg-studio-panel px-3 py-2">
        <BackLink ep={ep} />
        <h1 id="vp-title" className="font-display text-[18px] font-semibold" dir="auto">
          {ep.title}: AI video
        </h1>
        <span className="ml-auto text-[12px] text-studio-muted">
          {vp.settings.aspect}
          {vp.duration_s ? ` · ${Math.round(vp.duration_s / 6) / 10} min` : ''}
        </span>
      </header>
      <VPStepper current={step} states={states} onPick={go} />
      <section
        role="tabpanel"
        id={`vp-panel-${current.id}`}
        aria-labelledby={`vp-tab-${current.id}`}
        tabIndex={-1}
        className="min-h-0 flex-1 overflow-y-auto focus-visible:outline-none"
      >
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-5 md:px-8">
          <Progress vp={vp} />
          <ReviewBanner vp={vp} onGo={go} />
          <StepGate vp={vp} stepIndex={step - 1} onGo={go} />
          {q.isError && <ErrorState compact title="Couldn't refresh" error={q.error} onRetry={() => q.refetch()} />}
          {current.id === 'hosts' && <HostsPanel vp={vp} />}
          {current.id === 'set' && <SetPanel vp={vp} />}
          {current.id === 'look' && <LookPanel vp={vp} />}
          {current.id === 'cameras' && <CamerasPanel vp={vp} />}
          {current.id === 'render' && <RenderPanel vp={vp} />}
          {current.id === 'result' && <ResultPanel vp={vp} onRender={() => go(5)} />}
        </div>
      </section>
      <footer className="flex items-center gap-2 border-t border-studio-border bg-studio-panel px-3 py-2">
        <Button type="button" size="sm" variant="ghost" disabled={step === 1} onClick={() => go(step - 1)}>
          <ArrowLeft aria-hidden />
          Back
        </Button>
        <span className="text-[12px] text-studio-muted">
          Step {step} of {VP_STEPS.length}: {current.label}
        </span>
        {step < VP_STEPS.length && <NextButton vp={vp} step={step} onGo={go} />}
      </footer>
    </main>
  )
}

function Progress({ vp }: { vp: VideoPodcast }) {
  const job = vp.job
  const running = jobRunning(vp)
  return (
    <div className="flex flex-col gap-2">
      <StageTimeline stages={timelineStages(vp)} />
      <p role="status" aria-live="polite" className="text-small text-studio-muted">
        {running ? (
          <>
            <Loader2 aria-hidden className="mr-1 inline size-3.5 animate-spin" />
            {job?.message || 'Working…'}
            {vp.eta_s ? ` · about ${formatEstimate(vp.eta_s)} left` : ''}
          </>
        ) : null}
      </p>
      {!busy(job) && job?.status === 'failed' && (
        <p role="alert" className="text-small text-studio-danger">
          The last run failed{job.error ? `: ${job.error}` : '.'}
        </p>
      )}
    </div>
  )
}

// a review step's Next approves and moves the pipeline on, not just the view
function NextButton({ vp, step, onGo }: { vp: VideoPodcast; step: number; onGo: (n: number) => void }) {
  const go = useContinueAiVideo(vp.id)
  const status = vp.stages.find((s) => s.key === VP_STEPS[step - 1].stage)?.status
  const approve = status === 'review' && !jobRunning(vp)
  return (
    <Button
      type="button"
      size="sm"
      variant="primary"
      className="ml-auto"
      loading={go.isPending}
      onClick={() => {
        if (!approve) return onGo(step + 1)
        go.mutate(undefined, {
          onSuccess: () => {
            announce(`Approved. Working on the ${NOUN[VP_STEPS[step].stage].name} now.`)
            onGo(step + 1)
          },
        })
      }}
    >
      {approve ? `Approve and continue to ${VP_STEPS[step].label}` : `Next: ${VP_STEPS[step].label}`}
      <ArrowRight aria-hidden />
    </Button>
  )
}

const NOUN: Record<string, { name: string; plural: boolean }> = {
  cast: { name: 'host portraits', plural: true },
  set: { name: 'set', plural: false },
  keyframes: { name: 'camera angles', plural: true },
  plan: { name: 'cameras and the cut', plural: true },
  render: { name: 'render', plural: false },
  assemble: { name: 'final cut', plural: false },
}

/** Says why a step is still empty and offers the one action that moves it along. */
function StepGate({ vp, stepIndex, onGo }: { vp: VideoPodcast; stepIndex: number; onGo: (n: number) => void }) {
  const go = useContinueAiVideo(vp.id)
  const block = blockingStep(vp, stepIndex)
  if (!block) return null
  const here = NOUN[VP_STEPS[stepIndex].stage].name
  const { name: what, plural } = NOUN[block.step.stage]
  const be = plural ? 'are' : 'is'
  const running = block.status === 'running' || jobRunning(vp)
  return (
    <section aria-label="What this step is waiting for" className="flex flex-wrap items-center gap-3 rounded-[6px] border border-studio-border-strong bg-studio-raised p-3">
      <p className="mr-auto text-small">
        {running
          ? `Working on the ${what} first; the ${here} ${NOUN[VP_STEPS[stepIndex].stage].plural ? 'follow on their own' : 'follows on its own'}.`
          : block.status === 'review'
            ? `The ${what} ${be} waiting for your OK. Approve ${plural ? 'them' : 'it'} and the ${here} ${NOUN[VP_STEPS[stepIndex].stage].plural ? 'are' : 'is'} made next.`
            : block.status === 'failed'
              ? `The ${what} step failed, so the ${here} can't start yet.`
              : `The ${here} ${NOUN[VP_STEPS[stepIndex].stage].plural ? 'come' : 'comes'} after the ${what}. Start there.`}
      </p>
      {!running && block.status === 'review' && (
        <Button type="button" variant="primary" loading={go.isPending} onClick={() => go.mutate(undefined, { onSuccess: () => announce(`Approved. Working on the ${here} now.`) })}>
          Approve the {what} and continue
          <ArrowRight aria-hidden />
        </Button>
      )}
      {!running && block.status !== 'review' && (
        <Button type="button" variant="secondary" onClick={() => onGo(block.index + 1)}>
          Go to {block.step.label}
        </Button>
      )}
      {go.isError && (
        <p role="alert" className="w-full text-small text-studio-danger">
          {go.error.message}
        </p>
      )}
    </section>
  )
}

function ReviewBanner({ vp, onGo }: { vp: VideoPodcast; onGo: (n: number) => void }) {
  const go = useContinueAiVideo(vp.id)
  if (!vp.review || jobRunning(vp)) return null
  const hosts = vp.review === 'hosts'
  return (
    <section aria-label="Waiting for your review" className="flex flex-wrap items-center gap-3 rounded-[6px] border border-studio-accent bg-studio-accent-soft p-3 shadow-card">
      <p className="mr-auto text-small">
        {hosts
          ? 'Have a look at the host portraits. Regenerate any you don’t like, then continue to the set.'
          : 'Check the camera angles. Regenerate any that look wrong, then continue to the cameras and the cut.'}{' '}
        <span className="text-studio-muted">Anything not approved yet is approved as it is.</span>
      </p>
      <Button type="button" size="sm" variant="ghost" onClick={() => onGo(hosts ? 1 : 3)}>
        {hosts ? 'See the hosts' : 'See the angles'}
      </Button>
      <Button type="button" variant="primary" loading={go.isPending} onClick={() => go.mutate(undefined, { onSuccess: () => announce('Continuing.') })}>
        Continue
        <ArrowRight aria-hidden />
      </Button>
      {go.isError && (
        <p role="alert" className="w-full text-small text-studio-danger">
          {go.error.message}
        </p>
      )}
    </section>
  )
}

const STATE_TEXT = { done: 'done', todo: 'to do', busy: 'working', review: 'needs your OK' } as const

// the episode stepper's tabs, over the video's six steps
function VPStepper({ current, states, onPick }: { current: number; states: Record<string, VPStepState>; onPick: (n: number) => void }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const n = VP_STEPS.length
  const onKey = (e: React.KeyboardEvent, i: number) => {
    const to = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : null
    if (to === null) return
    e.preventDefault()
    const k = (to + n) % n
    onPick(k + 1)
    refs.current[k]?.focus()
  }
  return (
    <nav aria-label="AI video steps" className="border-b border-studio-border bg-studio-raised px-2 py-1.5">
      <div role="tablist" aria-label="Steps" className="flex gap-1 overflow-x-auto">
        {VP_STEPS.map((s, i) => {
          const on = i + 1 === current
          const st = states[s.id]
          return (
            <button
              key={s.id}
              ref={(el) => {
                refs.current[i] = el
              }}
              type="button"
              role="tab"
              id={`vp-tab-${s.id}`}
              aria-selected={on}
              aria-controls={`vp-panel-${s.id}`}
              tabIndex={on ? 0 : -1}
              onClick={() => onPick(i + 1)}
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
                  st === 'done' ? 'border-studio-success bg-studio-success text-studio-accent-fg' : st === 'review' ? 'border-studio-accent bg-studio-accent text-studio-accent-fg' : 'border-studio-border-strong',
                )}
              >
                {st === 'done' ? <Check /> : st === 'busy' ? <Loader2 className="animate-spin" /> : i + 1}
              </span>
              {s.label}
              {st === 'review' && <span aria-hidden className="text-[11px] text-studio-accent-hover">needs your OK</span>}
              <span className="sr-only">, {STATE_TEXT[st]}</span>
            </button>
          )
        })}
      </div>
    </nav>
  )
}
