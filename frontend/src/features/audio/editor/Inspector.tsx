import { useId, useState } from 'react'
import { Link } from 'react-router'
import { Plus, Scissors, Trash2, X } from 'lucide-react'
import { MediaPicker } from '@/components/media/MediaPicker'
import { Section } from '@/components/studio/section'
import { Button } from '@/components/ui/button'
import { DevelopSlider } from '@/features/photo/DevelopSlider'
import { useMediaItem } from '@/hooks/useMedia'
import {
  addCut,
  AMOUNT_RANGE,
  APPEND_MAX,
  CHAIN_PRESETS,
  FADE_CURVES,
  FADE_MAX,
  GAIN_RANGE,
  keepRegion,
  LOUDNESS,
  MARKER_LABEL_MAX,
  minus,
  PITCH_RANGE,
  SPEED_RANGE,
  stamp,
} from '@/lib/audio-edit'
import type { AudioEdit, FadeCurve, Generation, MediaDetail, TimeRegion } from '@/lib/types'
import { cn } from '@/lib/utils'
import { announce } from '@/stores/ui'

type Setter = (fn: (e: AudioEdit) => AudioEdit, group?: string | null) => void

interface Props {
  item: MediaDetail
  edit: AudioEdit
  set: Setter
  duration: number
  selection: TimeRegion | null
  onSelection: (r: TimeRegion | null) => void
  onSeek: (t: number) => void
  openedId: string | null
  compareId: string | null
  onCompare: (generationId: string) => void
}

const TILE = 'rounded-[4px] border px-2 py-1.5 text-left text-small transition-colors duration-150'
const tile = (on: boolean) => cn(TILE, on ? 'border-studio-accent bg-studio-accent-soft text-studio-text' : 'border-studio-border hover:bg-studio-panel-hover')
const FIELD = 'h-7 rounded-[4px] border border-studio-border bg-studio-raised px-1.5 text-small focus-visible:border-studio-accent'

function Fade({ which, edit, set }: { which: 'fade_in' | 'fade_out'; edit: AudioEdit; set: Setter }) {
  const id = useId()
  const f = edit[which] ?? { s: 0, curve: 'qsin' as FadeCurve }
  const label = which === 'fade_in' ? 'Fade in' : 'Fade out'
  const put = (next: { s: number; curve: FadeCurve }, group: string | null) => set((e) => ({ ...e, [which]: next.s > 0 ? next : null }), group)
  return (
    <div className="grid grid-cols-[1fr_auto_auto] items-center gap-2">
      <label htmlFor={`${id}-s`} className="text-small text-studio-muted">
        {label}
      </label>
      <span className="flex items-center gap-1">
        <input
          id={`${id}-s`}
          type="number"
          min={0}
          max={FADE_MAX}
          step={0.1}
          value={f.s}
          onChange={(e) => put({ ...f, s: Math.min(FADE_MAX, Math.max(0, Number(e.target.value) || 0)) }, `fade:${which}`)}
          className={cn(FIELD, 'w-16 text-right font-mono')}
        />
        <span className="text-[11px] text-studio-faint" aria-hidden>
          s
        </span>
      </span>
      <select aria-label={`${label} curve`} value={f.curve} onChange={(e) => put({ ...f, curve: e.target.value as FadeCurve }, null)} className={FIELD}>
        {FADE_CURVES.map((c) => (
          <option key={c.value} value={c.value}>
            {c.label}
          </option>
        ))}
      </select>
    </div>
  )
}

function JoinRow({ id, onRemove }: { id: string; onRemove: () => void }) {
  const title = useMediaItem(id).data?.title ?? 'Audio'
  return (
    <li className="flex items-center gap-1 text-small">
      <span className="min-w-0 flex-1 truncate">{title}</span>
      <button type="button" onClick={onRemove} aria-label={`Remove ${title} from the join`} className="rounded-[4px] p-1 text-studio-muted hover:bg-studio-panel-hover hover:text-studio-text">
        <X aria-hidden className="size-3.5" />
      </button>
    </li>
  )
}

// renders carry {edit, source_id} in their params (contract v15)
const versionLabel = (g: Generation) => (g.params?.edit ? 'Edited' : g.version > 1 ? 'Take' : 'Original')

/** The editor's right-hand panels, in the order the edit is applied. */
export function Inspector({ item, edit, set, duration, selection, onSelection, onSeek, openedId, compareId, onCompare }: Props) {
  const [picking, setPicking] = useState(false)
  const cuts = edit.cuts ?? []
  const markers = edit.markers ?? []
  const append = edit.append ?? []
  const loopId = useId()
  const versions = [...(item.versions ?? [])].sort((a, b) => b.version - a.version)
  const current = openedId ?? item.generation_id

  return (
    <div className="flex flex-col divide-y divide-studio-border px-2 text-small">
      <Section title="Trim & cut" count={cuts.length || undefined}>
        <div className="flex flex-col gap-2 pb-2">
          <p className="text-studio-muted" aria-live="polite">
            {selection ? `Region ${stamp(selection.start)} – ${stamp(selection.end)}` : 'Drag across the waveform, or press I and O, to mark a region.'}
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={!selection}
              onClick={() => {
                if (!selection) return
                set((e) => keepRegion(e, selection, duration))
                announce(`Keeping ${stamp(selection.start)} to ${stamp(selection.end)}.`)
              }}
            >
              Keep region
            </Button>
            <Button
              size="sm"
              disabled={!selection}
              onClick={() => {
                if (!selection) return
                set((e) => addCut(e, selection, duration))
                onSelection(null)
                announce(`Cut ${stamp(selection.start)} to ${stamp(selection.end)}.`)
              }}
            >
              <Scissors aria-hidden />
              Cut region
            </Button>
          </div>
          {edit.trim && (
            <p className="flex items-center gap-1">
              <span className="flex-1">
                Kept {stamp(edit.trim.start)} – {stamp(edit.trim.end)}
              </span>
              <Button size="sm" variant="ghost" onClick={() => set((e) => ({ ...e, trim: null }))}>
                Clear trim
              </Button>
            </p>
          )}
          {cuts.length > 0 && (
            <ul aria-label="Cuts" className="flex flex-col gap-0.5">
              {cuts.map((c, i) => (
                <li key={`${c.start}-${c.end}`} className="flex items-center gap-1">
                  <button type="button" onClick={() => onSeek(c.start)} className="flex-1 rounded-[4px] px-1 py-0.5 text-left font-mono hover:bg-studio-panel-hover">
                    {stamp(c.start)} – {stamp(c.end)}
                  </button>
                  <button
                    type="button"
                    onClick={() => set((e) => ({ ...e, cuts: (e.cuts ?? []).filter((_, j) => j !== i) }))}
                    aria-label={`Restore the cut ${stamp(c.start)} to ${stamp(c.end)}`}
                    className="rounded-[4px] p-1 text-studio-muted hover:bg-studio-panel-hover hover:text-studio-text"
                  >
                    <X aria-hidden className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Section>

      <Section title="Fades">
        <div className="flex flex-col gap-2 pb-2">
          <Fade which="fade_in" edit={edit} set={set} />
          <Fade which="fade_out" edit={edit} set={set} />
        </div>
      </Section>

      <Section title="Gain">
        <div className="pb-2">
          <DevelopSlider name="gain" label="Gain (dB)" value={edit.gain_db ?? 0} range={GAIN_RANGE} onChange={(v, g) => set((e) => ({ ...e, gain_db: v }), g)} />
        </div>
      </Section>

      <Section title="Speed & pitch" defaultOpen={false}>
        <div className="flex flex-col gap-2 pb-2">
          <DevelopSlider name="speed" label="Speed (×)" value={edit.speed ?? 1} range={SPEED_RANGE} onChange={(v, g) => set((e) => ({ ...e, speed: v }), g)} />
          <DevelopSlider name="pitch" label="Pitch (semitones)" value={edit.pitch ?? 0} range={PITCH_RANGE} onChange={(v, g) => set((e) => ({ ...e, pitch: v }), g)} />
          <p className="text-[11px] text-studio-faint">Speed keeps the pitch; pitch keeps the length.</p>
        </div>
      </Section>

      <Section title="Silence trim" defaultOpen={false}>
        <label className="flex items-start gap-2 pb-2">
          <input type="checkbox" checked={!!edit.silence_trim} onChange={(e) => set((x) => ({ ...x, silence_trim: e.target.checked }))} className="mt-0.5" />
          <span>
            Strip silence at the start and end
            <span className="block text-[11px] text-studio-faint">Anything below −50 dB.</span>
          </span>
        </label>
      </Section>

      <Section title="Loop to length" defaultOpen={false}>
        <div className="flex items-center gap-2 pb-2">
          <input
            id={loopId}
            type="checkbox"
            checked={edit.loop_to != null && edit.loop_to > 0}
            onChange={(e) => set((x) => ({ ...x, loop_to: e.target.checked ? Math.max(30, Math.ceil(duration * 2)) : null }))}
          />
          <label htmlFor={loopId} className="flex-1">
            Repeat up to
          </label>
          <input
            type="number"
            min={1}
            step={1}
            aria-label="Loop length in seconds"
            disabled={!edit.loop_to}
            value={edit.loop_to ?? ''}
            onChange={(e) => set((x) => ({ ...x, loop_to: Math.max(1, Number(e.target.value) || 1) }), 'loop_to')}
            className={cn(FIELD, 'w-20 text-right font-mono disabled:opacity-50')}
          />
          <span aria-hidden className="text-[11px] text-studio-faint">
            s
          </span>
        </div>
      </Section>

      <Section title="Join" count={append.length || undefined} defaultOpen={false}>
        <div className="flex flex-col gap-1.5 pb-2">
          {append.length > 0 && (
            <ol aria-label="Joined after this track" className="flex flex-col gap-0.5">
              {append.map((id, i) => (
                <JoinRow key={`${id}-${i}`} id={id} onRemove={() => set((e) => ({ ...e, append: (e.append ?? []).filter((_, j) => j !== i) }))} />
              ))}
            </ol>
          )}
          <Button size="sm" disabled={append.length >= APPEND_MAX} onClick={() => setPicking(true)}>
            <Plus aria-hidden />
            Add audio after this
          </Button>
          <MediaPicker
            open={picking}
            onOpenChange={setPicking}
            kind="audio"
            max={APPEND_MAX}
            taken={append}
            title="Join audio"
            description={`Pick up to ${APPEND_MAX - append.length} tracks to play after this one, with a short crossfade.`}
            confirmLabel="Join"
            onConfirm={(items) => set((e) => ({ ...e, append: [...(e.append ?? []), ...items.filter((m) => m.id !== item.id).map((m) => m.id)].slice(0, APPEND_MAX) }))}
          />
        </div>
      </Section>

      <Section title="Effect chain">
        <div className="flex flex-col gap-2 pb-2">
          <div role="group" aria-label="Effect preset" className="grid grid-cols-2 gap-1.5">
            <button type="button" aria-pressed={!edit.chain} onClick={() => set((e) => ({ ...e, chain: null }))} className={tile(!edit.chain)}>
              <span className="block font-medium">None</span>
              <span className="block text-[11px] text-studio-faint">As it is</span>
            </button>
            {CHAIN_PRESETS.map((p) => (
              <button
                key={p.value}
                type="button"
                aria-pressed={edit.chain?.preset === p.value}
                onClick={() => set((e) => ({ ...e, chain: { preset: p.value, amount: e.chain?.amount ?? AMOUNT_RANGE.default } }))}
                className={tile(edit.chain?.preset === p.value)}
              >
                <span className="block font-medium">{p.label}</span>
                <span className="block truncate text-[11px] text-studio-faint">{p.hint}</span>
              </button>
            ))}
          </div>
          {edit.chain && (
            <DevelopSlider name="amount" label="Amount (%)" value={edit.chain.amount} range={AMOUNT_RANGE} onChange={(v, g) => set((e) => (e.chain ? { ...e, chain: { ...e.chain, amount: v } } : e), g)} />
          )}
        </div>
      </Section>

      <Section title="Loudness">
        <div role="radiogroup" aria-label="Loudness target" className="grid grid-cols-2 gap-1.5 pb-2">
          <button type="button" role="radio" aria-checked={!edit.loudness} onClick={() => set((e) => ({ ...e, loudness: null }))} className={tile(!edit.loudness)}>
            <span className="block font-medium">Off</span>
            <span className="block text-[11px] text-studio-faint">Keep its level</span>
          </button>
          {LOUDNESS.map((l) => (
            <button key={l.value} type="button" role="radio" aria-checked={edit.loudness?.target === l.value} onClick={() => set((e) => ({ ...e, loudness: { target: l.value } }))} className={tile(edit.loudness?.target === l.value)}>
              <span className="block font-medium">{l.label}</span>
              <span className="block font-mono text-[11px] text-studio-faint">
                {minus(l.lufs)} LUFS · {minus(l.tp)} dBTP
              </span>
            </button>
          ))}
        </div>
      </Section>

      <Section title="Markers" count={markers.length || undefined}>
        <div className="pb-2">
          {markers.length === 0 ? (
            <p className="text-studio-faint">Press M to drop a marker at the playhead.</p>
          ) : (
            <ul aria-label="Markers" className="flex flex-col gap-1">
              {markers.map((m, i) => (
                <li key={i} className="flex items-center gap-1">
                  <button type="button" onClick={() => onSeek(m.t)} aria-label={`Go to ${m.label}`} className="w-14 shrink-0 rounded-[4px] px-1 py-0.5 text-left font-mono text-[11px] hover:bg-studio-panel-hover">
                    {stamp(m.t)}
                  </button>
                  <input
                    aria-label={`Marker ${i + 1} name`}
                    value={m.label}
                    maxLength={MARKER_LABEL_MAX}
                    onChange={(e) => set((x) => ({ ...x, markers: (x.markers ?? []).map((mm, j) => (j === i ? { ...mm, label: e.target.value } : mm)) }), `marker:${i}`)}
                    className={cn(FIELD, 'min-w-0 flex-1')}
                  />
                  <button
                    type="button"
                    onClick={() => set((x) => ({ ...x, markers: (x.markers ?? []).filter((_, j) => j !== i) }))}
                    aria-label={`Delete ${m.label}`}
                    className="rounded-[4px] p-1 text-studio-muted hover:bg-studio-panel-hover hover:text-studio-text"
                  >
                    <Trash2 aria-hidden className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Section>

      <Section title="Versions" count={versions.length || undefined}>
        <ul aria-label="Versions" className="flex flex-col gap-1 pb-2">
          {versions.map((g) => {
            const open = g.id === current
            const isA = (compareId ?? current) === g.id
            return (
              <li key={g.id} className={cn('flex items-center gap-1.5 rounded-[4px] px-1 py-1', open && 'bg-studio-accent-soft/50')}>
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">
                    v{g.version} · {versionLabel(g)}
                    {open && <span className="font-normal text-studio-faint"> · open</span>}
                  </span>
                  {g.note && <span className="block truncate text-[11px] text-studio-faint">{g.note}</span>}
                </span>
                <button
                  type="button"
                  aria-pressed={isA}
                  onClick={() => onCompare(g.id)}
                  aria-label={`Use version ${g.version} as A`}
                  title="Compare: play this as A"
                  className={cn('rounded-[4px] border px-1.5 text-[11px]', isA ? 'border-studio-accent bg-studio-accent-soft' : 'border-studio-border hover:bg-studio-panel-hover')}
                >
                  A
                </button>
                {!open && (
                  <Link to={`/audio/edit/${item.id}?version=${g.id}`} className="rounded-[4px] px-1.5 text-[11px] underline-offset-2 hover:underline" aria-label={`Open version ${g.version} in the editor`}>
                    Open
                  </Link>
                )}
              </li>
            )
          })}
        </ul>
      </Section>
    </div>
  )
}
