import { useId, useState } from 'react'
import { Clapperboard, RefreshCw } from 'lucide-react'
import { StatusPill } from '@/components/studio/status-pill'
import { Button } from '@/components/ui/button'
import { jobRunning, useAiVideoEstimate, useRenderAiVideo } from '@/hooks/useVideoPodcast'
import { generationStatus } from '@/lib/status'
import type { VideoPodcast, VPQuality, VPShot } from '@/lib/types'
import { plural } from '@/lib/utils'
import { announce } from '@/stores/ui'
import { aspectClass, clock, speakerName, typeOf } from './vp'

const QUALITIES: { value: VPQuality; label: string; hint: string }[] = [
  { value: 'draft', label: 'Draft', hint: 'Quick, 480p. Check the cut and the lip sync.' },
  { value: 'final', label: 'Final', hint: '720p, upscaled in a second pass. Only changed shots are made again.' },
]

const ready = (s: VPShot, q: VPQuality) => {
  const t = s.takes[q]
  return !!t?.media_url && (t.status === 'ready' || t.status === 'approved')
}

export function RenderPanel({ vp }: { vp: VideoPodcast }) {
  const uid = useId()
  const [quality, setQuality] = useState<VPQuality>(vp.outputs.draft ? 'final' : 'draft')
  const estimate = useAiVideoEstimate(vp.id, quality)
  const render = useRenderAiVideo(vp.id)
  const locked = jobRunning(vp)
  const noPlan = vp.plan.length === 0
  const done = vp.plan.filter((s) => ready(s, quality)).length
  const label = QUALITIES.find((q) => q.value === quality)!.label

  const go = (shotIds?: string[]) =>
    !locked &&
    render.mutate(shotIds ? { quality, shot_ids: shotIds } : { quality }, {
      onSuccess: () => announce(shotIds ? 'Rendering that shot again.' : `Rendering the ${quality}.`),
    })

  return (
    <>
      <div>
        <h2 className="font-display text-title font-semibold">Render</h2>
        <p className="text-small text-studio-muted">Every shot becomes a take on the video GPU, then the takes are cut together over the episode mix.</p>
      </div>
      {noPlan && <p className="rounded-[6px] border border-studio-warning/50 bg-studio-warning/5 p-3 text-small">Plan the shots first (step 4).</p>}
      {vp.mix_stale && <p className="text-small text-studio-warning">The mix changed after the plan was made: replan in Shots before the final render.</p>}

      <section aria-labelledby={`${uid}-go`} className="flex flex-col gap-3 rounded-[6px] border border-studio-border-strong bg-studio-panel p-3 shadow-card">
        <h3 id={`${uid}-go`} className="font-display text-[15px] font-semibold">
          Quality
        </h3>
        <fieldset className="flex flex-col gap-1.5 text-small">
          <legend className="sr-only">Quality</legend>
          {QUALITIES.map((q) => (
            <label key={q.value} className="flex items-start gap-2">
              <input type="radio" name={`${uid}-q`} value={q.value} checked={quality === q.value} onChange={() => setQuality(q.value)} className="mt-0.5 accent-studio-accent" />
              <span>
                <span className="font-medium">{q.label}</span> <span className="text-studio-muted">{q.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <div aria-live="polite" className="text-small">
          {estimate.isPending ? (
            <span className="text-studio-muted">Working out how long it takes…</span>
          ) : estimate.isError ? (
            <span className="text-studio-danger">Couldn't estimate the time: {estimate.error.message}</span>
          ) : estimate.data.shots === 0 ? (
            <span className="text-studio-muted">Every shot already has a {quality} take. Rendering again only cuts the video.</span>
          ) : (
            <span>
              <span className="font-medium">{estimate.data.label}</span>
              <span className="text-studio-muted"> · {plural(estimate.data.shots, 'shot')} to render</span>
            </span>
          )}
        </div>
        <Button type="button" variant="primary" className="self-start" disabled={noPlan || locked} loading={render.isPending && !render.variables?.shot_ids} onClick={() => go()}>
          <Clapperboard aria-hidden />
          Render {label.toLowerCase()}
        </Button>
        {render.isError && (
          <p role="alert" className="text-small text-studio-danger">
            {render.error.message}
          </p>
        )}
      </section>

      {!noPlan && (
        <section aria-labelledby={`${uid}-takes`} className="flex flex-col gap-2">
          <div className="flex flex-wrap items-baseline gap-2">
            <h3 id={`${uid}-takes`} className="mr-auto font-display text-[15px] font-semibold">
              Takes
            </h3>
            <span role="status" className="text-small text-studio-muted">
              {done} of {plural(vp.plan.length, 'shot')} have a {quality} take
            </span>
          </div>
          <ul aria-label={`${label} takes`} className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {vp.plan.map((s, i) => (
              <TakeTile key={s.id} vp={vp} shot={s} n={i + 1} quality={quality} locked={locked} onRerender={() => go([s.id])} />
            ))}
          </ul>
        </section>
      )}
    </>
  )
}

function TakeTile({ vp, shot, n, quality, locked, onRerender }: { vp: VideoPodcast; shot: VPShot; n: number; quality: VPQuality; locked: boolean; onRerender: () => void }) {
  const take = shot.takes[quality]
  const name = `Shot ${n}, ${typeOf(shot.type).label}, ${speakerName(vp, shot)}`
  const status = take
    ? generationStatus(take.status)
    : shot.needs[quality]
      ? ({ label: 'Not rendered', tone: 'neutral', icon: 'clock' } as const)
      : ({ label: 'Up to date', tone: 'success', icon: 'check' } as const)
  return (
    <li className="flex flex-col gap-1.5 rounded-[6px] border border-studio-border bg-studio-panel p-1.5">
      <div className={`darkroom overflow-hidden rounded-[4px] ${aspectClass(vp.settings.aspect)}`}>
        {ready(shot, quality) ? (
          <video src={take!.media_url!} preload="metadata" muted playsInline controls aria-label={name} className="size-full object-cover" />
        ) : shot.thumb_url ? (
          <img src={shot.thumb_url} alt={name} loading="lazy" className="size-full object-cover" />
        ) : (
          <span className="flex size-full items-center justify-center text-[11px] text-studio-on-dark-muted">{shot.type === 'cover' ? 'Cover' : 'No frame'}</span>
        )}
      </div>
      <div className="flex items-center justify-between gap-1 text-[11px]">
        <span className="font-mono text-studio-muted">
          {n} · {clock(shot.start)}
        </span>
        <StatusPill status={status} />
      </div>
      {shot.needs[quality] && take && <span className="text-[11px] text-studio-warning">Changed since this take</span>}
      <Button type="button" size="sm" variant="ghost" className="self-start" disabled={locked} aria-label={`Re-render shot ${n}`} onClick={onRerender}>
        <RefreshCw aria-hidden />
        Re-render
      </Button>
    </li>
  )
}
