import { ArrowRight, ListTree, RefreshCcw, Stamp } from 'lucide-react'
import { CLOSING_LABEL, closingOf, logoRetryNote } from '@/lib/brand'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/alert-dialog'
import { StatusPill } from '@/components/studio/status-pill'
import { ErrorState } from '@/components/studio/states'
import { useGenerationActions } from '@/hooks/useGenerations'
import { useStudioImageModel } from '@/hooks/useStudioImageModel'
import { useClearStale, useCreateShot, useDeleteShot, useReorderShots } from '@/hooks/useShots'
import { formatDuration } from '@/lib/duration'
import { shotLabel, startFrameOf, type FrameUnit } from '@/lib/shots'
import { shotStatus } from '@/lib/status'
import type { Generation, GenerationKind, Shot } from '@/lib/types'
import { cn, plural } from '@/lib/utils'
import { announce } from '@/stores/ui'
import type { FrameSide, ShotSelection } from '@/stores/workspace'
import { FrameSlot } from './FrameSlot'
import { ShotFields } from './ShotFields'
import { ShotMenu } from './ShotMenu'
import { useRewritePrompts } from './useRewritePrompts'

interface Props {
  unit: FrameUnit
  view: 'scenes' | 'shots'
  sceneShots: Shot[]
  labelFor: (shot: Shot) => string
  selection: ShotSelection | undefined
  aspectClass: string
  onSelectFrame: (shot: Shot, side: FrameSide) => void
  onOpenShots: () => void
}

export function FrameRow({ unit, view, sceneShots, labelFor, selection, aspectClass, onSelectFrame, onOpenShots }: Props) {
  const { startShot, endShot, prevShot } = unit
  const { create, regenerate } = useGenerationActions()
  const imageModel = useStudioImageModel(startShot.project_id)
  const clearStale = useClearStale()
  const rewrite = useRewritePrompts(startShot)
  const reorder = useReorderShots(startShot.project_id)
  const insert = useCreateShot(startShot.project_id)
  const remove = useDeleteShot(startShot.project_id)

  const label = view === 'shots' ? shotLabel(unit.sceneIndex, unit.shotIndex ?? 0) : `Scene ${unit.sceneIndex + 1}`
  const start = startFrameOf(startShot, prevShot)
  const stale = view === 'shots' ? startShot.stale : sceneShots.some((s) => s.stale)
  const isSel = (shot: Shot, side: FrameSide) => selection?.shotId === shot.id && selection.frame === side

  const generate = (shot: Shot, kind: GenerationKind) =>
    create.mutate(
      { target: { targetType: 'shot', targetId: shot.id, kind }, params: imageModel.params },
      { onSuccess: (g) => announce(`${kind === 'keyframe_start' ? 'START' : 'END'} frame for ${label} queued (v${g.version}).`) },
    )

  // the shot's placements already feed the logo in; the note says what the check didn't like
  const retryLogo = (frame: Generation | null | undefined, side: string) => (issues: string[]) =>
    frame &&
    regenerate.mutate(
      { id: frame.id, mode: 'note', note: logoRetryNote(issues) },
      { onSuccess: (g) => announce(`${side} frame for ${label} regenerating with the logo (v${g.version}).`) },
    )
  const closing = closingOf(endShot) ?? closingOf(startShot)

  const move = (dir: -1 | 1) => {
    const i = sceneShots.indexOf(startShot)
    const ids = sceneShots.map((s) => s.id)
    ;[ids[i], ids[i + dir]] = [ids[i + dir], ids[i]]
    reorder.mutate({ sceneId: unit.scene.id, ids }, { onSuccess: () => announce(`Shot moved to position ${i + dir + 1}.`) })
  }

  const selected = isSel(startShot, 'start') || isSel(endShot, 'end')
  const error = create.error ?? regenerate.error ?? clearStale.error ?? reorder.error ?? insert.error ?? remove.error ?? rewrite.error

  return (
    <article
      aria-label={view === 'shots' ? `Shot ${label}` : `${label}: ${unit.scene.heading || 'Untitled scene'}`}
      className={cn(
        'rounded-[6px] border bg-studio-panel p-3 shadow-card transition-colors duration-150',
        selected ? 'border-studio-accent' : 'border-studio-border-strong',
      )}
    >
      <header className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="rounded-[4px] bg-studio-accent-soft px-1.5 font-mono text-small font-medium text-studio-accent-hover">
          {label}
        </span>
        {view === 'scenes' ? (
          <h3 className="min-w-0 flex-1 truncate font-display text-panel font-semibold">{unit.scene.heading || 'Untitled scene'}</h3>
        ) : (
          <span className="flex-1" />
        )}
        <span className="font-mono text-small text-studio-muted">
          {sceneShots.length && view === 'scenes'
            ? formatDuration(sceneShots.reduce((t, s) => t + s.duration_s, 0))
            : formatDuration(startShot.duration_s)}
        </span>
        {closing && (
          <span className="inline-flex items-center gap-1 rounded-full border border-studio-gold/70 bg-studio-gold/10 px-2 text-small">
            <Stamp aria-hidden className="size-3" />
            Brand closing · {CLOSING_LABEL[closing]}
          </span>
        )}
        {view === 'shots' && <StatusPill status={shotStatus(startShot.status)} />}
        {stale && (
          <span className="inline-flex items-center gap-1 text-small text-studio-warning">
            <RefreshCcw aria-hidden className="size-3" />
            Stale
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-1.5"
              onClick={() => sceneShots.filter((s) => s.stale && (view === 'scenes' || s.id === startShot.id)).forEach((s) => clearStale.mutate(s.id))}
            >
              Clear
            </Button>
          </span>
        )}
        {view === 'scenes' && unit.shotCount > 1 && (
          <Button size="sm" variant="ghost" onClick={onOpenShots}>
            <ListTree aria-hidden />
            {plural(unit.shotCount, 'shot')}
          </Button>
        )}
        {view === 'shots' && (
          <ShotMenu
            label={label}
            canMoveUp={(unit.shotIndex ?? 0) > 0}
            canMoveDown={(unit.shotIndex ?? 0) < unit.shotCount - 1}
            stale={startShot.stale}
            onMove={move}
            onInsertAfter={() => insert.mutate({ sceneId: unit.scene.id, after_shot_id: startShot.id })}
            onRewritePrompts={rewrite.request}
            onClearStale={() => clearStale.mutate(startShot.id)}
            onDelete={() => remove.mutate(startShot.id, { onSuccess: () => announce(`Shot ${label} deleted.`) })}
          />
        )}
      </header>

      <div className={cn('grid gap-3', view === 'shots' && 'xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]')}>
        <div className="flex items-start gap-2">
          <FrameSlot
            side="START"
            frame={start.frame}
            alt={`START frame of ${label}: ${startShot.description || unit.scene.heading}`}
            aspectClass={aspectClass}
            selected={isSel(startShot, 'start')}
            onSelect={() => onSelectFrame(startShot, 'start')}
            linkedFrom={start.linked ? (start.from ? labelFor(start.from) : 'previous shot') : undefined}
            onGenerate={() => generate(startShot, 'keyframe_start')}
            onRegenerateWithLogo={retryLogo(start.frame, 'START')}
            regeneratingLogo={regenerate.isPending}
          />
          <ArrowRight aria-hidden className="mt-[22%] size-4 shrink-0 text-studio-gold" />
          <FrameSlot
            side="END"
            frame={endShot.end_frame}
            alt={`END frame of ${label}: ${endShot.description || unit.scene.heading}`}
            aspectClass={aspectClass}
            selected={isSel(endShot, 'end')}
            onSelect={() => onSelectFrame(endShot, 'end')}
            onGenerate={() => generate(endShot, 'keyframe_end')}
            onRegenerateWithLogo={retryLogo(endShot.end_frame, 'END')}
            regeneratingLogo={regenerate.isPending}
          />
        </div>
        {view === 'shots' ? (
          <ShotFields shot={startShot} label={label} />
        ) : (
          (unit.scene.logline || startShot.description) && (
            <p className="line-clamp-2 text-small text-studio-muted">{unit.scene.logline || startShot.description}</p>
          )
        )}
      </div>
      {rewrite.status && (
        <p role="status" className="mt-2 text-small text-studio-muted">
          {rewrite.status}
        </p>
      )}
      {error ? <ErrorState compact className="mt-2" title="That didn't work" error={error} /> : null}
      <ConfirmDialog
        open={rewrite.confirming}
        onOpenChange={rewrite.setConfirming}
        title="Replace your hand-written prompts?"
        description="This shot's prompts are manual. Rewriting switches it back to Auto and the AI replaces the START, END and motion prompts."
        confirmLabel="Switch to Auto and rewrite"
        onConfirm={rewrite.confirm}
      />
    </article>
  )
}
