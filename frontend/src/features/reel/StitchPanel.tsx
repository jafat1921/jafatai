import { useId, useState } from 'react'
import { Link } from 'react-router'
import { CheckCircle2, Clapperboard, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { fieldClass, Input } from '@/components/ui/input'
import { Kbd } from '@/components/ui/kbd'
import { Progress } from '@/components/ui/progress'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { ErrorState } from '@/components/studio/states'
import { useJobs } from '@/hooks/useJobs'
import { useAssemble, useRenders } from '@/hooks/useReel'
import { formatTimecode } from '@/lib/duration'
import { modKey } from '@/lib/keyboard'
import { renderInfo, stitchPayload, type StitchMode, type StitchScene } from '@/lib/stitch'
import { isActiveJob } from '@/lib/status'
import { cn, plural } from '@/lib/utils'
import { announce } from '@/stores/ui'
import type { Stitch } from './useStitch'

const sceneOption = (s: StitchScene) =>
  `${s.number} · ${s.scene.heading || 'Untitled scene'}${s.ready ? '' : ' (needs approved take)'}`

export function StitchPanel({ projectId, stitch }: { projectId: string; stitch: Stitch }) {
  const { scenes, state, selection } = stitch
  const assemble = useAssemble(projectId)
  const renders = useRenders(projectId)
  const { data: jobs } = useJobs()
  // null = follow the automatic label as the selection changes
  const [title, setTitle] = useState<string | null>(null)
  const [started, setStarted] = useState<string[]>([])
  const ids = { from: useId(), to: useId(), name: useId(), summary: useId() }
  const renderHref = `/projects/${projectId}/render`
  const outputHref = `/projects/${projectId}/output`

  const titleFor = (generationId?: string | null) => {
    const r = renders.data?.find((g) => g.id === generationId)
    return r ? renderInfo(r).title : 'Stitched video'
  }
  const running = (jobs ?? []).filter((j) => j.project_id === projectId && j.type === 'reel_assemble' && isActiveJob(j.status))
  const finished = started
    .map((id) => jobs?.find((j) => j.id === id))
    .filter((j) => j && (j.status === 'done' || j.status === 'failed'))

  const empty = selection.included.length === 0
  const submit = () => {
    if (empty || assemble.isPending) return
    const body = stitchPayload(selection, title ?? '')
    assemble.mutate(body, {
      onSuccess: (job) => {
        const already = started.includes(job.id) || running.some((j) => j.id === job.id)
        announce(already ? 'That selection is already stitching.' : `Stitching ${body.title ?? selection.autoTitle}.`)
        setStarted((s) => (s.includes(job.id) ? s : [...s, job.id]))
        setTitle(null)
      },
    })
  }

  return (
    <section
      aria-labelledby={`${ids.summary}-h`}
      className="flex flex-col gap-3 rounded-[6px] border border-studio-border-strong bg-studio-panel p-3 shadow-card"
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault()
          submit()
        }
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={`${ids.summary}-h`} className="font-display text-panel font-semibold">
          Stitch a video
        </h2>
        <ToggleGroup
          type="single"
          aria-label="Choose scenes by"
          value={state.mode}
          onValueChange={(v) => v && stitch.setMode(v as StitchMode)}
        >
          <ToggleGroupItem value="range">Range</ToggleGroupItem>
          <ToggleGroupItem value="pick">Pick scenes</ToggleGroupItem>
        </ToggleGroup>
      </div>

      {state.mode === 'range' ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex min-w-40 flex-1 flex-col gap-1">
              <label htmlFor={ids.from} className="section-label">
                From scene
              </label>
              <select
                id={ids.from}
                className={cn(fieldClass, 'h-8')}
                value={state.from}
                onChange={(e) => stitch.setFrom(Number(e.target.value))}
              >
                {scenes.map((s) => (
                  <option key={s.scene.scene_id} value={s.number}>
                    {sceneOption(s)}
                  </option>
                ))}
              </select>
            </div>
            <span aria-hidden className="pb-1.5 text-studio-muted">
              →
            </span>
            <div className="flex min-w-40 flex-1 flex-col gap-1">
              <label htmlFor={ids.to} className="section-label">
                To scene
              </label>
              <select
                id={ids.to}
                className={cn(fieldClass, 'h-8')}
                value={state.to}
                onChange={(e) => stitch.setTo(Number(e.target.value))}
              >
                {scenes.map((s) => (
                  <option key={s.scene.scene_id} value={s.number}>
                    {sceneOption(s)}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {selection.skipped.length > 0 && (
            <p className="text-small text-studio-muted">
              {selection.skipped.map((s) => `Scene ${s.number}`).join(', ')}{' '}
              {selection.skipped.length === 1 ? 'needs an approved take and is' : 'need approved takes and are'} left
              out.{' '}
              <Link to={renderHref} className="text-studio-accent-hover underline underline-offset-2">
                Open Render
              </Link>
            </p>
          )}
        </div>
      ) : (
        <fieldset className="flex flex-col gap-1">
          <legend className="section-label mb-1">Scenes to stitch</legend>
          <ul className="flex max-h-56 flex-col gap-0.5 overflow-y-auto">
            {scenes.map((s) => {
              const id = `stitch-pick-${s.scene.scene_id}`
              return (
                <li key={s.scene.scene_id} className="flex items-center gap-2 rounded-[4px] px-1 py-0.5 hover:bg-studio-panel-hover">
                  <input
                    id={id}
                    type="checkbox"
                    className="size-4 accent-studio-accent"
                    disabled={!s.ready}
                    checked={s.ready && state.picked.includes(s.scene.scene_id)}
                    onChange={() => stitch.togglePick(s.scene.scene_id)}
                  />
                  <label htmlFor={id} className={cn('flex min-w-0 flex-1 items-center gap-2 text-body', !s.ready && 'text-studio-muted')}>
                    <span className="font-mono text-small">Sc {s.number}</span>
                    <span className="min-w-0 flex-1 truncate">{s.scene.heading || 'Untitled scene'}</span>
                    {s.ready ? (
                      <span className="font-mono text-small text-studio-muted">{formatTimecode(s.scene.duration_s)}</span>
                    ) : (
                      <span className="text-small">needs approved take</span>
                    )}
                  </label>
                  {!s.ready && (
                    <Link
                      to={renderHref}
                      className="text-small text-studio-accent-hover underline underline-offset-2"
                      aria-label={`Scene ${s.number}: open in Render`}
                    >
                      Render
                    </Link>
                  )}
                </li>
              )
            })}
          </ul>
          <div className="flex gap-1">
            <Button size="sm" variant="ghost" onClick={() => stitch.setPicked(scenes.filter((s) => s.ready).map((s) => s.scene.scene_id))}>
              Select all
            </Button>
            <Button size="sm" variant="ghost" onClick={() => stitch.setPicked([])}>
              Clear
            </Button>
          </div>
        </fieldset>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <div className="flex min-w-48 flex-1 flex-col gap-1">
          <label htmlFor={ids.name} className="section-label">
            Name
          </label>
          <Input
            id={ids.name}
            value={title ?? selection.autoTitle}
            maxLength={200}
            placeholder={selection.autoTitle || 'Choose scenes first'}
            onChange={(e) => setTitle(e.target.value)}
            aria-describedby={ids.summary}
          />
        </div>
        <Button
          variant="primary"
          size="lg"
          onClick={submit}
          disabled={empty}
          loading={assemble.isPending}
          aria-keyshortcuts="Control+Enter"
        >
          <Clapperboard aria-hidden />
          Stitch video
          <Kbd>{modKey}+Enter</Kbd>
        </Button>
      </div>
      <p id={ids.summary} aria-live="polite" className="text-small text-studio-muted">
        {empty
          ? 'Pick at least one scene with an approved take.'
          : [
              plural(selection.included.length, 'scene'),
              formatTimecode(selection.durationS),
              selection.cached ? `reuses ${plural(selection.cached, 'cached scene')}` : 'every scene gets built',
            ].join(' · ')}
      </p>

      {assemble.isError && <ErrorState compact title="Couldn't start stitching" error={assemble.error} />}

      {running.length > 0 && (
        <ul aria-label="Stitching now" className="flex flex-col gap-2">
          {running.map((j) => (
            <li key={j.id} role="status" className="flex flex-col gap-1">
              <span className="text-small">
                <span className="font-medium">{titleFor(j.generation_id)}</span>
                <span className="text-studio-muted"> · {j.status === 'queued' ? 'waiting its turn' : j.message || 'stitching…'}</span>
              </span>
              <Progress value={j.status === 'running' ? j.progress : null} label={`Stitching ${titleFor(j.generation_id)}`} />
            </li>
          ))}
        </ul>
      )}

      {finished.map((j) =>
        j ? (
          <div
            key={j.id}
            role="status"
            className={cn(
              'flex flex-wrap items-center gap-2 rounded-[6px] border px-2 py-1.5 text-small',
              j.status === 'done' ? 'border-studio-success/60' : 'border-studio-danger/40 bg-studio-danger/5',
            )}
          >
            {j.status === 'done' ? <CheckCircle2 aria-hidden className="size-4 text-studio-success" /> : null}
            <span className="min-w-0 flex-1">
              {j.status === 'done'
                ? `“${titleFor(j.generation_id)}” is ready.`
                : `“${titleFor(j.generation_id)}” failed${j.error ? `: ${j.error}` : '.'}`}
            </span>
            {j.status === 'done' && (
              <Button asChild size="sm" variant="secondary">
                <Link to={outputHref}>Open in Output</Link>
              </Button>
            )}
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Dismiss"
              onClick={() => setStarted((s) => s.filter((id) => id !== j.id))}
            >
              <X aria-hidden />
            </Button>
          </div>
        ) : null,
      )}
    </section>
  )
}
