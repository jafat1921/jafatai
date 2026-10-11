import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, Circle, Loader2, Pause, Play, RefreshCw, SlidersHorizontal, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { AerabButton } from '@/components/text/AerabButton'
import { clock } from '@/lib/audio'
import { STATUS_LABEL, VIRTUAL_AFTER, needsTts, type CastMember, type LineKind, type LineStatus, type ScriptLine } from '@/lib/dialogue'
import { clampSpeed, speedText } from '@/lib/voice'
import type { Voice, VoiceEngine } from '@/lib/types'
import { cn } from '@/lib/utils'
import { togglePlay, useTrack } from '../sharedAudio'
import { SpeedChip, VoiceChip } from '../voice/VoiceChips'

const ROW_H = 84
const OVERSCAN = 8
const FALLBACK_VIEW = 900

const PILL: Record<LineStatus, string> = {
  empty: 'border-studio-border text-studio-muted',
  stale: 'border-studio-warning text-studio-warning',
  rendering: 'border-studio-accent text-studio-accent',
  ready: 'border-studio-success text-studio-success',
  failed: 'border-studio-danger text-studio-danger',
}

const PILL_ICON: Record<LineStatus, React.ReactNode> = {
  empty: <Circle aria-hidden />,
  stale: <AlertTriangle aria-hidden />,
  rendering: <Loader2 aria-hidden className="animate-spin" />,
  ready: <CheckCircle2 aria-hidden />,
  failed: <AlertTriangle aria-hidden />,
}

export function StatusPill({ status, error }: { status: LineStatus; error?: string | null }) {
  return (
    <span
      title={error ?? undefined}
      className={cn('inline-flex h-6 shrink-0 items-center gap-1 rounded-full border bg-studio-raised px-2 text-[11px] font-medium [&_svg]:size-3', PILL[status])}
    >
      {PILL_ICON[status]}
      {STATUS_LABEL[status]}
    </span>
  )
}

// contract-v20: how a line that isn't plain speech is marked
const KIND_LABEL: Partial<Record<LineKind, string>> = { recording: 'Recording', ad: 'Ad', music: 'Music', break: 'Pause' }

export interface LineSelection {
  ids: ReadonlySet<string>
  toggle: (id: string) => void
}

export interface LineActions {
  change: (id: string, patch: Partial<ScriptLine>) => void
  insertAfter: (index: number, text?: string) => string
  remove: (index: number) => void
  move: (from: number, to: number) => void
  render: (id: string) => void
}

interface Props {
  lines: ScriptLine[]
  cast: CastMember[]
  voices: Voice[]
  engines: VoiceEngine[]
  title: string
  actions: LineActions
  // a line id to put the caret in once it's on screen (a new line)
  focusText: string | null
  onFocused: () => void
  // the script's language, for the voice picker's Gallery section
  language?: string
  // ticks to pick lines (Podcast's LLM edits act on the picked ones)
  selection?: LineSelection
  // where this list starts in the whole script, when a script is shown as several lists (Podcast chapters)
  offset?: number
}

interface Focus {
  id: string
  target: 'row' | 'text'
  caret?: 'start' | 'end'
}

const colorOf =(cast: CastMember[], id: string) => cast.find((c) => c.id === id)?.color ?? 'var(--color-studio-border-strong)'

export function LineList({ lines, cast, voices, engines, title, actions, focusText, onFocused, language, selection, offset = 0 }: Props) {
  const box = useRef<HTMLDivElement>(null)
  const rows = useRef(new Map<string, HTMLLIElement>())
  const texts = useRef(new Map<string, HTMLTextAreaElement>())
  const [scroll, setScroll] = useState(0)
  const [view, setView] = useState(FALLBACK_VIEW)
  const pending = useRef<Focus | null>(null)
  const [, kick] = useState(0)
  const setPending = (f: Focus) => {
    pending.current = f
    kick((n) => n + 1)
  }
  const virtual = lines.length > VIRTUAL_AFTER

  useLayoutEffect(() => {
    const el = box.current
    if (!el || !virtual) return
    const measure = () => setView(el.clientHeight || FALLBACK_VIEW)
    measure()
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    ro?.observe(el)
    return () => ro?.disconnect()
  }, [virtual])

  const first = virtual ? Math.max(0, Math.floor(scroll / ROW_H) - OVERSCAN) : 0
  const last = virtual ? Math.min(lines.length, Math.ceil((scroll + view) / ROW_H) + OVERSCAN) : lines.length

  const focusLine = (index: number, target: 'row' | 'text' = 'row', caret?: 'start' | 'end') => {
    const l = lines[index]
    if (!l) return
    if (virtual && (index < first || index >= last) && box.current) {
      box.current.scrollTop = Math.max(0, index * ROW_H - view / 2)
      setScroll(box.current.scrollTop)
    }
    setPending({ id: l.id, target, caret })
  }

  // after every render: the row asked for may only exist now (a new line, a scrolled-in window)
  useEffect(() => {
    const want = pending.current ?? (focusText ? { id: focusText, target: 'text' as const, caret: 'end' as const } : null)
    if (!want) return
    const el = want.target === 'text' ? texts.current.get(want.id) : rows.current.get(want.id)
    if (!el) return
    el.focus()
    if (el instanceof HTMLTextAreaElement && want.caret) {
      const at = want.caret === 'start' ? 0 : el.value.length
      el.setSelectionRange(at, at)
    }
    if (pending.current) pending.current = null
    else onFocused()
  })

  const onRowKey = (e: React.KeyboardEvent<HTMLLIElement>, i: number) => {
    if (e.target !== e.currentTarget) return
    const l = lines[i]
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      actions.move(i, e.key === 'ArrowUp' ? i - 1 : i + 1)
      setPending({ id: l.id, target: 'row' })
    } else if (e.key === 'ArrowUp') focusLine(i - 1)
    else if (e.key === 'ArrowDown') focusLine(i + 1)
    else if (e.key === 'Home') focusLine(0)
    else if (e.key === 'End') focusLine(lines.length - 1)
    else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) actions.render(l.id)
    else if (e.key === 'Enter') {
      const id = actions.insertAfter(i)
      setPending({ id, target: 'text' })
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      const next = lines[i + 1] ?? lines[i - 1]
      actions.remove(i)
      if (next) setPending({ id: next.id, target: 'row' })
    } else if (e.key === 'F2') focusLine(i, 'text', 'end')
    else return
    e.preventDefault()
  }

  const onTextKey = (e: React.KeyboardEvent<HTMLTextAreaElement>, i: number) => {
    const el = e.currentTarget
    const l = lines[i]
    if (e.nativeEvent.isComposing) return
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      const to = e.key === 'ArrowUp' ? i - 1 : i + 1
      actions.move(i, to)
      if (to >= 0 && to < lines.length) setPending({ id: l.id, target: 'text' })
    } else if (e.key === 'Escape') focusLine(i)
    else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) actions.render(l.id)
    else if (e.key === 'Enter' && !e.shiftKey) {
      // Enter splits the line at the caret, like a new paragraph in a word processor
      const before = el.value.slice(0, el.selectionStart).trimEnd()
      const after = el.value.slice(el.selectionEnd).trimStart()
      if (after) actions.change(l.id, { text: before })
      const id = actions.insertAfter(i, after)
      setPending({ id, target: 'text', caret: 'start' })
    } else if (e.key === 'Backspace' && el.value === '' && lines.length > 1) {
      const prev = lines[i - 1]
      actions.remove(i)
      if (prev) setPending({ id: prev.id, target: 'text', caret: 'end' })
    } else if (e.key === 'ArrowUp' && el.selectionStart === 0 && el.selectionEnd === 0 && i > 0) focusLine(i - 1, 'text', 'end')
    else if (e.key === 'ArrowDown' && el.selectionStart === el.value.length && i < lines.length - 1) focusLine(i + 1, 'text', 'start')
    else return
    e.preventDefault()
  }

  const shown = lines.slice(first, last)
  return (
    <div
      ref={box}
      onScroll={virtual ? (e) => setScroll(e.currentTarget.scrollTop) : undefined}
      className="min-h-0 flex-1 overflow-y-auto"
    >
      <ol aria-label="Lines" className="flex flex-col" style={virtual ? { paddingTop: first * ROW_H, paddingBottom: (lines.length - last) * ROW_H } : undefined}>
        {shown.map((l, k) => {
          const i = first + k
          return (
            <LineRow
              key={l.id}
              line={l}
              index={i}
              offset={offset}
              cast={cast}
              voices={voices}
              engines={engines}
              language={language}
              selection={selection}
              scriptTitle={title}
              fixed={virtual}
              actions={actions}
              rowRef={(el) => (el ? rows.current.set(l.id, el) : rows.current.delete(l.id))}
              textRef={(el) => (el ? texts.current.set(l.id, el) : texts.current.delete(l.id))}
              onRowKey={(e) => onRowKey(e, i)}
              onTextKey={(e) => onTextKey(e, i)}
            />
          )
        })}
      </ol>
    </div>
  )
}

interface RowProps {
  line: ScriptLine
  index: number
  offset: number
  cast: CastMember[]
  voices: Voice[]
  engines: VoiceEngine[]
  language?: string
  selection?: LineSelection
  scriptTitle: string
  fixed: boolean
  actions: LineActions
  rowRef: (el: HTMLLIElement | null) => void
  textRef: (el: HTMLTextAreaElement | null) => void
  onRowKey: (e: React.KeyboardEvent<HTMLLIElement>) => void
  onTextKey: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
}

function LineRow({ line, index, offset, cast, voices, engines, language, selection, scriptTitle, fixed, actions, rowRef, textRef, onRowKey, onTextKey }: RowProps) {
  const n = offset + index + 1
  const speaker = cast.find((c) => c.id === line.speaker_id)
  const track = useTrack(`take-${line.id}`)
  const overrides = [line.voice_id && 'voice', line.speed != null && line.speed !== 1 && speedText(line.speed), line.emotion].filter(Boolean)
  const play = () =>
    line.take_url && togglePlay(`take-${line.id}`, line.take_url, { title: `${scriptTitle} · ${speaker?.name ?? 'Line'} ${n}`, mediaId: line.take_media_id ?? null })

  return (
    <li
      ref={rowRef}
      tabIndex={0}
      onKeyDown={onRowKey}
      aria-label={`Line ${n}, ${speaker?.name ?? 'Narrator'}: ${STATUS_LABEL[line.status]}`}
      className={cn(
        'group flex gap-2 border-b border-studio-border px-3 py-2 focus-visible:bg-studio-accent-soft focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-studio-accent',
        fixed && 'h-[84px] overflow-hidden',
      )}
      style={{ boxShadow: `inset 3px 0 0 ${colorOf(cast, line.speaker_id)}` }}
    >
      {selection && (
        <input
          type="checkbox"
          aria-label={`Select line ${n}`}
          checked={selection.ids.has(line.id)}
          onChange={() => selection.toggle(line.id)}
          className="mt-2 size-4 shrink-0 accent-studio-accent"
        />
      )}
      <span aria-hidden className="w-7 shrink-0 pt-1.5 text-right font-mono text-[11px] text-studio-faint">
        {n}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <label className="sr-only" htmlFor={`spk-${line.id}`}>
            Speaker for line {n}
          </label>
          <span aria-hidden className="size-2.5 shrink-0 rounded-full" style={{ background: colorOf(cast, line.speaker_id) }} />
          <select
            id={`spk-${line.id}`}
            value={line.speaker_id}
            onChange={(e) => actions.change(line.id, { speaker_id: e.target.value })}
            className="h-6 max-w-40 rounded-full border border-studio-border-strong bg-studio-raised px-2 text-[12px] font-medium"
            style={{ color: speaker?.color ?? undefined }}
          >
            {cast.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <LineSettings line={line} n={n} voices={voices} engines={engines} language={language} onChange={(p) => actions.change(line.id, p)} active={overrides.length > 0} />
          {overrides.length > 0 && <span className="truncate text-[11px] text-studio-muted">{overrides.join(' · ')}</span>}
          {line.kind && KIND_LABEL[line.kind] && (
            <span className="rounded-[4px] border border-studio-border-strong px-1.5 text-[11px] leading-5 text-studio-muted">{KIND_LABEL[line.kind]}</span>
          )}
          {needsTts(line) && (
            <AerabButton text={line.text} onText={(t) => actions.change(line.id, { text: t })} language={language} target={`line ${n}`} showNote={false} className="[&_button]:h-6" />
          )}
          <span className="ml-auto flex items-center gap-1.5">
            <label className="flex items-center gap-1 text-[11px] text-studio-muted">
              Pause
              <Input
                type="number"
                min={0}
                max={10}
                step={0.05}
                inputMode="decimal"
                aria-label={`Pause after line ${n}, seconds`}
                placeholder={line.para ? 'para' : 'auto'}
                value={line.pause_after_s ?? ''}
                onChange={(e) => actions.change(line.id, { pause_after_s: e.target.value === '' ? null : Math.min(10, Math.max(0, Number(e.target.value))) })}
                className="h-6 w-16 px-1.5 text-[12px]"
              />
            </label>
            <StatusPill status={line.status} error={line.error} />
            {line.duration_s ? <span className="font-mono text-[11px] text-studio-faint">{clock(line.duration_s)}</span> : null}
          </span>
        </div>
        <textarea
          ref={textRef}
          dir="auto"
          aria-label={`Line ${n} text`}
          rows={fixed ? 1 : Math.min(6, Math.max(1, Math.ceil(line.text.length / 90)))}
          maxLength={5000}
          value={line.text}
          onChange={(e) => actions.change(line.id, { text: e.target.value })}
          onKeyDown={onTextKey}
          placeholder="Type the line…"
          className="w-full resize-none rounded-[4px] border border-transparent bg-transparent px-1.5 py-1 text-body leading-6 hover:border-studio-border focus-visible:border-studio-border-strong focus-visible:bg-studio-raised focus-visible:outline-none"
        />
        {line.status === 'failed' && line.error && (
          <p className="text-[11px] text-studio-danger" role="note">
            {line.error}
          </p>
        )}
      </div>
      <div className="flex shrink-0 flex-col items-center gap-1">
        <Button type="button" size="icon-sm" variant="ghost" disabled={!line.take_url} aria-label={`${track.playing ? 'Pause' : 'Play'} line ${n}`} onClick={play}>
          {track.playing ? <Pause aria-hidden /> : <Play aria-hidden />}
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          disabled={!line.text.trim() || line.status === 'rendering' || !needsTts(line)}
          aria-label={`Render line ${n}`}
          title="Render this line (Ctrl+Enter)"
          onClick={() => actions.render(line.id)}
        >
          <RefreshCw aria-hidden />
        </Button>
        <Button type="button" size="icon-sm" variant="ghost" aria-label={`Remove line ${n}`} onClick={() => actions.remove(index)} className="opacity-60 group-hover:opacity-100 group-focus-within:opacity-100">
          <Trash2 aria-hidden />
        </Button>
      </div>
    </li>
  )
}

function LineSettings({ line, n, voices, engines, language, onChange, active }: { line: ScriptLine; n: number; voices: Voice[]; engines: VoiceEngine[]; language?: string; onChange: (p: Partial<ScriptLine>) => void; active: boolean }) {
  return (
    <Popover>
      <PopoverTrigger
        aria-label={`Settings for line ${n}`}
        className={cn(
          'inline-flex size-6 items-center justify-center rounded-full border [&_svg]:size-3.5',
          active ? 'border-studio-accent bg-studio-accent-soft text-studio-text' : 'border-studio-border-strong bg-studio-raised text-studio-muted hover:text-studio-text',
        )}
      >
        <SlidersHorizontal aria-hidden />
      </PopoverTrigger>
      <PopoverContent aria-label={`Line ${n} settings`} className="flex w-80 flex-col gap-3">
        <p className="section-label">Line {n}: overrides</p>
        <div className="flex flex-wrap gap-1.5">
          <VoiceChip name="Line voice" voices={voices} engines={engines} language={language} value={line.voice_id} onChange={(v) => onChange({ voice_id: v })} />
          <SpeedChip value={line.speed ?? 1} onChange={(v) => onChange({ speed: clampSpeed(v) === 1 ? null : clampSpeed(v) })} />
        </div>
        <label className="flex flex-col gap-1 text-small">
          <span className="section-label">Emotion</span>
          <Input value={line.emotion ?? ''} maxLength={120} placeholder="quietly, angry, amused…" onChange={(e) => onChange({ emotion: e.target.value || null })} />
          <span className="text-[11px] text-studio-muted">OmniVoice takes it as an instruction; Chatterbox as how strongly to act it.</span>
        </label>
        <label className="flex items-center gap-2 text-small">
          <input type="checkbox" checked={line.para} onChange={(e) => onChange({ para: e.target.checked })} className="accent-studio-accent" />
          Ends a paragraph (the longer gap after it)
        </label>
        {active && (
          <Button type="button" size="sm" variant="ghost" onClick={() => onChange({ voice_id: null, speed: null, emotion: null })}>
            Use the speaker's settings
          </Button>
        )}
      </PopoverContent>
    </Popover>
  )
}
