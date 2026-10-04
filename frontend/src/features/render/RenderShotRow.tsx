import { useState } from 'react'
import { Link } from 'react-router'
import { ArrowRight, Clapperboard, ImageOff, RefreshCcw, Timer } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/alert-dialog'
import { DurationPicker } from '@/components/studio/duration-picker'
import { fieldClass } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { ErrorState } from '@/components/studio/states'
import { StatusPill } from '@/components/studio/status-pill'
import { useGenerations } from '@/hooks/useGenerations'
import { useShotEstimate } from '@/hooks/useEstimate'
import { useRenderTakes } from '@/hooks/useShots'
import { estimateText, formatDuration, isLongTake } from '@/lib/duration'
import { canRender, isApproved, startFrameOf } from '@/lib/shots'
import { shotStatus } from '@/lib/status'
import type { Generation, Shot } from '@/lib/types'
import { cn, plural } from '@/lib/utils'
import { announce } from '@/stores/ui'
import { TakeThumb } from './TakeThumb'
import { takesInOrder } from './takes'

function MiniFrame({ frame, label }: { frame: Generation | null | undefined; label: string }) {
  return (
    <div className="darkroom flex aspect-video w-20 items-center justify-center overflow-hidden rounded-[4px]">
      {frame?.media_url ? (
        <img src={frame.media_url} alt={label} className="size-full object-cover" loading="lazy" />
      ) : (
        <ImageOff aria-label={`${label}: none`} className="size-4 text-studio-on-dark-muted" />
      )}
    </div>
  )
}

interface Props {
  shot: Shot
  prev: Shot | undefined
  label: string
  defaultCount: number
  selected: boolean
  selectedTakeId: string | undefined
  muted: boolean
  aspectClass: string
  storyboardHref: string
  onSelectShot: () => void
  onSelectTake: (take: Generation) => void
  onOpenStoryboard: () => void
}

export function RenderShotRow(p: Props) {
  const { shot, label } = p
  const takes = useGenerations({ targetType: 'shot', targetId: shot.id, kind: 'take' }, false)
  const render = useRenderTakes()
  // per-request override; the shot keeps its own length unless changed in the Storyboard
  const [durationOverride, setDuration] = useState<number | null>(null)
  const duration = durationOverride ?? shot.duration_s
  const long = isLongTake(shot, duration)
  // long takes are expensive, so they default to one take (contract v2)
  const [countOverride, setCount] = useState<number | null>(null)
  const count = countOverride ?? (long ? 1 : p.defaultCount)
  const [confirming, setConfirming] = useState(false)
  const { estimate } = useShotEstimate(confirming ? shot.id : undefined, duration)
  const start = startFrameOf(shot, p.prev)
  const ready = canRender(shot, p.prev)
  const list = takesInOrder(takes.data)

  const submit = () =>
    render.mutate(
      { shotId: shot.id, count, durationS: duration !== shot.duration_s ? duration : undefined },
      { onSuccess: (jobs) => announce(`${plural(jobs.length, 'take')} queued for shot ${label}.`) },
    )

  return (
    <article
      aria-label={`Shot ${label}`}
      className={cn(
        'rounded-[6px] border bg-studio-panel p-3 shadow-card',
        p.selected ? 'border-studio-accent' : 'border-studio-border-strong',
      )}
    >
      <header className="mb-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={p.onSelectShot}
          aria-pressed={p.selected}
          className="rounded-[4px] bg-studio-accent-soft px-1.5 font-mono text-small font-medium text-studio-accent-hover"
        >
          {label}
        </button>
        <span className="min-w-0 flex-1 truncate text-body">{shot.description || 'No description'}</span>
        {long && (
          <span className="inline-flex items-center gap-1 rounded-[4px] border border-studio-border-strong px-1.5 text-small text-studio-muted">
            <Timer aria-hidden className="size-3" />
            Long take
          </span>
        )}
        <span className="font-mono text-small text-studio-muted">{formatDuration(shot.duration_s)}</span>
        <StatusPill status={shotStatus(shot.status)} />
        {shot.stale && (
          <span className="inline-flex items-center gap-1 text-small text-studio-warning">
            <RefreshCcw aria-hidden className="size-3" />
            Stale
          </span>
        )}
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1.5">
          <MiniFrame frame={start.frame} label={`START of ${label}`} />
          <ArrowRight aria-hidden className="size-3.5 text-studio-gold" />
          <MiniFrame frame={shot.end_frame} label={`END of ${label}`} />
        </div>
        {ready ? (
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-0.5">
              <span className="section-label">Length</span>
              <DurationPicker
                value={duration}
                shotId={shot.id}
                count={count}
                label={`Take length for shot ${label}`}
                onChange={(v) => setDuration(v === shot.duration_s ? null : v)}
              />
            </div>
            <div className="flex flex-col gap-0.5">
              <label htmlFor={`takes-${shot.id}`} className="section-label">
                Takes
              </label>
              <input
                id={`takes-${shot.id}`}
                type="number"
                min={1}
                max={8}
                value={count}
                onChange={(e) => setCount(Math.min(8, Math.max(1, Math.round(Number(e.target.value) || 1))))}
                className={cn(fieldClass, 'h-7 w-14 font-mono text-small')}
              />
            </div>
            <Button size="sm" variant="primary" onClick={() => setConfirming(true)} loading={render.isPending}>
              <Clapperboard aria-hidden />
              Render takes
            </Button>
            {long && count > 1 && (
              <span role="note" className="text-small text-studio-warning">
                {count} long takes = {count}× the GPU time.
              </span>
            )}
            {!isApproved(shot.end_frame) && (
              <span className="text-small text-studio-muted">No approved END: takes animate from START only.</span>
            )}
          </div>
        ) : (
          <p className="text-small text-studio-muted">
            Needs an approved START frame.{' '}
            <Link to={p.storyboardHref} onClick={p.onOpenStoryboard} className="font-medium text-studio-accent-hover underline underline-offset-2">
              Approve frames in Storyboard
            </Link>
          </p>
        )}
      </div>

      {(list.length > 0 || takes.isPending) && (
        <div className="mt-3 overflow-x-auto pb-1">
          {takes.isPending ? (
            <Skeleton className="h-24 w-44" />
          ) : (
            <ol className="flex gap-2" aria-label={`Takes for shot ${label}`}>
              {list.map((t, i) => (
                <li key={t.id}>
                  <TakeThumb
                    take={t}
                    n={i + 1}
                    label={label}
                    selected={p.selectedTakeId === t.id}
                    muted={p.muted}
                    aspectClass={p.aspectClass}
                    onSelect={() => p.onSelectTake(t)}
                  />
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
      {takes.isError && <ErrorState compact className="mt-2" error={takes.error} onRetry={() => takes.refetch()} />}
      {render.isError && <ErrorState compact className="mt-2" title="Couldn't queue takes" error={render.error} />}

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Render ${plural(count, 'take')} of shot ${label}?`}
        description={
          <>
            {formatDuration(duration)} each
            {duration !== shot.duration_s && ` (the shot is set to ${formatDuration(shot.duration_s)})`}.{' '}
            {estimate && `${estimateText(estimate, count)}.`}
            {long && count > 1 && (
              <span className="mt-2 block font-medium text-studio-warning">
                Long takes are expensive: {count} takes cost {count}× the GPU time. One take is usually enough, since a bad
                chunk can be re-rolled on its own.
              </span>
            )}
          </>
        }
        confirmLabel={`Render ${plural(count, 'take')}`}
        onConfirm={submit}
      />
    </article>
  )
}
