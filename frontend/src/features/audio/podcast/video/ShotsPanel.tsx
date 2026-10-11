import { useId, useRef, useState } from 'react'
import { Merge, RotateCcw, Scissors } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/alert-dialog'
import { jobRunning, useMergeAiVideoShots, usePatchAiVideoShot, useReplanAiVideo, useSplitAiVideoShot } from '@/hooks/useVideoPodcast'
import type { VideoPodcast, VPShot, VPShotType } from '@/lib/types'
import { cn, plural } from '@/lib/utils'
import { announce } from '@/stores/ui'
import { StageAction } from './StageAction'
import { SHOT_TYPES, anglesFor, clock, picture, speakerName, typeOf } from './vp'

const SELECT = 'h-8 w-full rounded-[6px] border border-studio-border-strong bg-studio-raised px-2 text-body'

export function ShotsPanel({ vp }: { vp: VideoPodcast }) {
  const replan = useReplanAiVideo(vp.id)
  const edit = usePatchAiVideoShot(vp.id)
  const split = useSplitAiVideoShot(vp.id)
  const merge = useMergeAiVideoShots(vp.id)
  const [confirm, setConfirm] = useState(false)
  const [picked, setPicked] = useState<string | null>(null)
  const rows = useRef(new Map<string, HTMLSelectElement | null>())
  const locked = jobRunning(vp)
  const st = vp.plan_stats
  const error = [replan, edit, split, merge].find((m) => m.isError)?.error

  const focusRow = (id: string) => {
    setPicked(id)
    const el = rows.current.get(id)
    el?.scrollIntoView?.({ block: 'nearest' })
    el?.focus()
  }

  return (
    <>
      <div className="flex flex-wrap items-start gap-2">
        <div className="mr-auto">
          <h2 className="font-display text-title font-semibold">Shots</h2>
          <p className="text-small text-studio-muted">The cut, made from the mix: who is on screen, from which angle, and when. Change a shot's type or angle, split or merge shots.</p>
        </div>
        {vp.plan.length > 0 && (
          <Button type="button" size="sm" disabled={locked || !vp.duration_s} loading={replan.isPending} onClick={() => setConfirm(true)}>
            <RotateCcw aria-hidden />
            Replan
          </Button>
        )}
      </div>
      <StageAction vp={vp} stage="plan" label="Plan the shots" hint="The plan follows the mix line by line. Nothing is rendered yet." />
      {vp.mix_stale && (
        <p role="status" className="rounded-[6px] border border-studio-warning/50 bg-studio-warning/5 p-3 text-small">
          The mix changed after this plan was made. Replan so the shots match it.
        </p>
      )}

      {vp.plan.length === 0 ? (
        <p className="text-small text-studio-muted">No shots yet. The plan is made after the camera angles.</p>
      ) : (
        <>
          <p className="text-small text-studio-muted">
            {plural(st.shots, 'shot')} · {st.lipsync} lip-sync · {st.medium} two-shot · {plural(st.reaction, 'reaction')} · {st.wide} wide
            {st.cover ? ` · ${st.cover} cover` : ''} · {clock(st.seconds)}
          </p>
          <Timeline vp={vp} picked={picked} onPick={focusRow} />
          <div className="overflow-x-auto rounded-[6px] border border-studio-border-strong bg-studio-panel">
            <table className="w-full min-w-[760px] text-small">
              <caption className="sr-only">Shots in time order</caption>
              <thead className="border-b border-studio-border text-left text-[11px] uppercase tracking-wide text-studio-muted">
                <tr>
                  <th scope="col" className="px-2 py-1.5">#</th>
                  <th scope="col" className="px-2 py-1.5">Type</th>
                  <th scope="col" className="px-2 py-1.5">Speaker</th>
                  <th scope="col" className="px-2 py-1.5">Time</th>
                  <th scope="col" className="px-2 py-1.5">Angle</th>
                  <th scope="col" className="px-2 py-1.5">Line</th>
                  <th scope="col" className="px-2 py-1.5">Redo</th>
                  <th scope="col" className="px-2 py-1.5">
                    <span className="sr-only">Edit</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {vp.plan.map((s, i) => (
                  <ShotRow
                    key={s.id}
                    vp={vp}
                    shot={s}
                    n={i + 1}
                    next={vp.plan[i + 1]}
                    picked={picked === s.id}
                    locked={locked}
                    typeRef={(el) => {
                      rows.current.set(s.id, el)
                    }}
                    onEdit={(body) => edit.mutate({ shotId: s.id, ...body })}
                    onSplit={() => split.mutate({ shotId: s.id }, { onSuccess: () => announce(`Shot ${i + 1} split in two.`) })}
                    onMerge={(nextId) => merge.mutate([s.id, nextId], { onSuccess: () => announce(`Shots ${i + 1} and ${i + 2} merged.`) })}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {error && (
        <p role="alert" className="text-small text-studio-danger">
          {error.message}
        </p>
      )}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Make the plan again?"
        description="The shots are rebuilt from the mix. Your edits to types, angles, splits and merges are lost."
        confirmLabel="Replan"
        tone="danger"
        onConfirm={() => replan.mutate(undefined, { onSuccess: () => announce('Shot plan rebuilt.') })}
      />
    </>
  )
}

/** Shots as proportional blocks; one tab stop, arrows move along it, Enter jumps to the shot's row. */
function Timeline({ vp, picked, onPick }: { vp: VideoPodcast; picked: string | null; onPick: (id: string) => void }) {
  const uid = useId()
  const [at, setAt] = useState(0)
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const total = vp.duration_s || vp.plan.at(-1)?.end || 1
  const n = vp.plan.length
  const cur = Math.min(at, n - 1)
  const onKey = (e: React.KeyboardEvent) => {
    const to = e.key === 'ArrowRight' ? cur + 1 : e.key === 'ArrowLeft' ? cur - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : null
    if (to === null) return
    e.preventDefault()
    const i = Math.max(0, Math.min(n - 1, to))
    setAt(i)
    refs.current[i]?.focus()
  }
  return (
    <div className="flex flex-col gap-1.5">
      <div role="group" aria-label="Shot timeline" aria-describedby={`${uid}-help`} onKeyDown={onKey} className="flex h-10 w-full overflow-hidden rounded-[6px] border border-studio-border-strong bg-studio-raised">
        {vp.plan.map((s, i) => {
          const t = typeOf(s.type)
          return (
            <button
              key={s.id}
              ref={(el) => {
                refs.current[i] = el
              }}
              type="button"
              tabIndex={i === cur ? 0 : -1}
              aria-label={`Shot ${i + 1}: ${t.label}, ${speakerName(vp, s)}, ${clock(s.start)} to ${clock(s.end)}`}
              aria-current={picked === s.id || undefined}
              title={`${i + 1}. ${t.label} · ${clock(s.start)}–${clock(s.end)}`}
              onFocus={() => setAt(i)}
              onClick={() => onPick(s.id)}
              style={{ width: `${(Math.max(0, s.end - s.start) / total) * 100}%` }}
              className={cn(
                'h-full min-w-[2px] border-r border-studio-panel last:border-r-0 focus-visible:relative focus-visible:z-10',
                t.swatch,
                picked === s.id && 'outline-2 -outline-offset-2 outline-studio-text',
                s.marked && 'opacity-80',
              )}
            />
          )
        })}
      </div>
      <p id={`${uid}-help`} className="sr-only">
        Left and right arrows move between shots. Enter opens the shot in the list.
      </p>
      <ul aria-label="Shot types" className="flex flex-wrap gap-3 text-[11px] text-studio-muted">
        {SHOT_TYPES.map((t) => (
          <li key={t.value} className="flex items-center gap-1">
            <span aria-hidden className={cn('size-2.5 rounded-[2px] border border-studio-border-strong', t.swatch)} />
            {t.label}
          </li>
        ))}
      </ul>
    </div>
  )
}

function ShotRow({
  vp,
  shot,
  n,
  next,
  picked,
  locked,
  typeRef,
  onEdit,
  onSplit,
  onMerge,
}: {
  vp: VideoPodcast
  shot: VPShot
  n: number
  next?: VPShot
  picked: boolean
  locked: boolean
  typeRef: (el: HTMLSelectElement | null) => void
  onEdit: (body: { type?: VPShotType; angle?: string; marked?: boolean }) => void
  onSplit: () => void
  onMerge: (nextId: string) => void
}) {
  const options = anglesFor(shot.type, vp.angles, shot.speaker_id)
  const angle = vp.angles.find((a) => a.key === shot.angle)
  const thumb = shot.thumb_url ?? picture(angle?.frame)
  const changeType = (type: VPShotType) => {
    const valid = anglesFor(type, vp.angles, shot.speaker_id)
    const keep = valid.some((a) => a.key === shot.angle)
    onEdit({ type, angle: keep ? shot.angle : (valid[0]?.key ?? '') })
  }
  return (
    <tr className={cn('border-b border-studio-border last:border-b-0', picked && 'bg-studio-accent-soft')}>
      <td className="px-2 py-1.5 font-mono text-studio-muted">{n}</td>
      <td className="px-2 py-1.5">
        <select ref={typeRef} aria-label={`Shot ${n} type`} value={shot.type} disabled={locked} onChange={(e) => changeType(e.target.value as VPShotType)} className={cn(SELECT, 'w-44')}>
          {SHOT_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </td>
      <td className="px-2 py-1.5" dir="auto">
        {speakerName(vp, shot)}
      </td>
      <td className="whitespace-nowrap px-2 py-1.5 font-mono">
        {clock(shot.start)}–{clock(shot.end)}
      </td>
      <td className="px-2 py-1.5">
        {shot.type === 'cover' ? (
          <span className="text-studio-muted">Show cover</span>
        ) : (
          <span className="flex items-center gap-1.5">
            <span className="darkroom block aspect-video w-12 shrink-0 overflow-hidden rounded-[3px]">{thumb && <img src={thumb} alt="" loading="lazy" className="size-full object-cover" />}</span>
            <select aria-label={`Shot ${n} angle`} value={shot.angle} disabled={locked || options.length < 2} onChange={(e) => onEdit({ angle: e.target.value })} className={cn(SELECT, 'w-40')}>
              {!options.some((a) => a.key === shot.angle) && <option value={shot.angle}>{angle?.label ?? 'Pick an angle'}</option>}
              {options.map((a) => (
                <option key={a.key} value={a.key}>
                  {a.label}
                  {a.host_id && a.host_id !== shot.speaker_id ? ` (${vp.hosts.find((h) => h.host_id === a.host_id)?.name ?? ''})` : ''}
                </option>
              ))}
            </select>
          </span>
        )}
      </td>
      <td className="max-w-56 px-2 py-1.5">
        <span className="line-clamp-2" dir="auto" title={shot.text}>
          {shot.text || <span className="text-studio-muted">{shot.line_id ? '' : 'No speech'}</span>}
        </span>
      </td>
      <td className="px-2 py-1.5">
        <input
          type="checkbox"
          aria-label={`Render shot ${n} again next time`}
          checked={shot.marked}
          disabled={locked}
          onChange={(e) => onEdit({ marked: e.target.checked })}
          className="size-4 accent-studio-accent"
        />
      </td>
      <td className="px-2 py-1.5">
        <span className="flex gap-1">
          <Button type="button" size="icon-sm" variant="ghost" aria-label={`Split shot ${n}`} title="Split in the middle" disabled={locked || shot.end - shot.start < 1} onClick={onSplit}>
            <Scissors aria-hidden />
          </Button>
          <Button type="button" size="icon-sm" variant="ghost" aria-label={`Merge shot ${n} with the next`} title="Merge with the next shot" disabled={locked || !next} onClick={() => next && onMerge(next.id)}>
            <Merge aria-hidden />
          </Button>
        </span>
      </td>
    </tr>
  )
}
