import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Pause, Play } from 'lucide-react'
import { fitPill, flagged, stamp, STATUS_LABEL, windowRange, type DubSegment, type DubSpeaker } from '@/lib/dub'
import { cn } from '@/lib/utils'
import { togglePlay, useTrack } from '../sharedAudio'

export const ROW_H = 60
const VIEW_H = 420

interface Props {
  segments: DubSegment[]
  speakers: DubSpeaker[]
  lang: string
  langName: string
  showTarget: boolean
  focused: number
  selected: Set<string>
  playing: number
  colorOf: (speakerId: string | null) => string
  onFocus: (i: number, extend?: boolean) => void
  onToggle: (id: string) => void
  onEdit: () => void
  onSeek: (t: number) => void
}

function TakeButton({ seg, lang }: { seg: DubSegment; lang: string }) {
  const url = seg.target?.[lang]?.take_url
  const id = `dub-take:${seg.id}:${lang}`
  const { playing } = useTrack(id)
  if (!url) return <span className="size-7" />
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        togglePlay(id, url, { title: `Line take ${seg.target[lang]?.take_id ?? ''}`, peaks: false })
      }}
      aria-label={`${playing ? 'Pause' : 'Play'} this line's take`}
      className="flex size-7 shrink-0 items-center justify-center rounded-full text-studio-muted hover:bg-studio-panel-hover hover:text-studio-text"
    >
      {playing ? <Pause aria-hidden className="size-3.5" /> : <Play aria-hidden className="size-3.5" />}
    </button>
  )
}

/**
 * The lines, windowed: only the rows on screen are in the DOM, so a feature-length dub with a
 * thousand lines scrolls like a short one. Focus moves with ↑/↓ (the page handles the keys).
 */
export function SegmentTable({ segments, speakers, lang, langName, showTarget, focused, selected, playing, colorOf, onFocus, onToggle, onEdit, onSeek }: Props) {
  const box = useRef<HTMLDivElement>(null)
  const [scroll, setScroll] = useState(0)
  const [viewport, setViewport] = useState(VIEW_H)
  const [first, last] = windowRange(scroll, viewport, ROW_H, segments.length)
  const label = (id: string | null) => speakers.find((s) => s.id === id)?.label ?? 'Unassigned'

  useEffect(() => {
    const el = box.current
    if (el && el.clientHeight) setViewport(el.clientHeight)
  }, [])

  // keep the focused line on screen
  useEffect(() => {
    const el = box.current
    if (!el || focused < 0) return
    const top = focused * ROW_H
    if (top < el.scrollTop) el.scrollTop = top
    else if (top + ROW_H > el.scrollTop + (el.clientHeight || VIEW_H)) el.scrollTop = top + ROW_H - (el.clientHeight || VIEW_H)
  }, [focused])

  const active = segments[focused]
  return (
    <div
      ref={box}
      role="listbox"
      aria-label={`Lines, ${langName}`}
      aria-multiselectable
      tabIndex={0}
      aria-activedescendant={active ? `dub-row-${active.id}` : undefined}
      onScroll={(e) => setScroll(e.currentTarget.scrollTop)}
      onDoubleClick={onEdit}
      className="relative overflow-y-auto rounded-[6px] border border-studio-border bg-studio-panel focus-visible:outline-2 focus-visible:outline-studio-accent"
      style={{ height: VIEW_H }}
      data-dub-lines
    >
      <div style={{ height: segments.length * ROW_H, position: 'relative' }}>
        {segments.slice(first, last).map((s, k) => {
          const i = first + k
          const t = s.target?.[lang]
          const flags = flagged(t)
          const pill = fitPill(t)
          const status = t?.status ?? 'pending'
          return (
            <div
              key={s.id}
              id={`dub-row-${s.id}`}
              role="option"
              aria-selected={selected.has(s.id)}
              aria-label={`Line ${i + 1}, ${stamp(s.start)}, ${label(s.speaker_id)}: ${s.source_text}${showTarget && t?.text ? `. ${langName}: ${t.text}` : ''}${flags.length ? `. ${flags.join('. ')}` : ''}`}
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey) onToggle(s.id)
                else onFocus(i, e.shiftKey)
              }}
              className={cn(
                'absolute inset-x-0 flex items-center gap-2 border-b border-studio-border px-2 text-small',
                i === focused && 'bg-studio-panel-hover shadow-[inset_3px_0_0_var(--color-studio-accent)]',
                selected.has(s.id) && 'bg-studio-accent/10',
                i === playing && 'outline outline-1 -outline-offset-1 outline-studio-accent/50',
              )}
              style={{ top: i * ROW_H, height: ROW_H }}
            >
              <span
                aria-hidden
                onClick={(e) => {
                  e.stopPropagation()
                  onToggle(s.id)
                }}
                className={cn('flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-[3px] border', selected.has(s.id) ? 'border-studio-accent bg-studio-accent text-studio-accent-fg' : 'border-studio-border-strong')}
              >
                {selected.has(s.id) && '✓'}
              </span>
              <button
                type="button"
                tabIndex={-1}
                onClick={(e) => {
                  e.stopPropagation()
                  onFocus(i)
                  onSeek(s.start)
                }}
                className="w-16 shrink-0 text-left font-mono text-[11px] text-studio-muted hover:text-studio-text"
                aria-label={`Seek to ${stamp(s.start)}`}
              >
                {stamp(s.start)}
                <span className="block">{(s.end - s.start).toFixed(1)} s</span>
              </button>
              <span className="flex w-24 shrink-0 items-center gap-1.5 truncate">
                <span aria-hidden className="size-2.5 shrink-0 rounded-full" style={{ background: colorOf(s.speaker_id) }} />
                <span className="truncate">{label(s.speaker_id)}</span>
              </span>
              <p className="line-clamp-2 min-w-0 flex-1" dir="auto">
                {s.source_text}
              </p>
              {showTarget && (
                <p className={cn('line-clamp-2 min-w-0 flex-1', !t?.text && 'italic text-studio-muted')} dir="auto" lang={lang}>
                  {t?.text || 'Not translated yet'}
                </p>
              )}
              {showTarget && (
                <span
                  className={cn(
                    'hidden w-28 shrink-0 truncate rounded-full border px-1.5 text-center text-[11px] leading-5 lg:block',
                    pill.tone === 'warn' ? 'border-studio-warning text-studio-warning' : pill.tone === 'ok' ? 'border-studio-accent/60' : 'border-studio-border text-studio-muted',
                  )}
                >
                  {pill.label}
                </span>
              )}
              <span className="flex w-5 shrink-0 justify-center" title={flags.join(' · ') || undefined}>
                {flags.length > 0 && <AlertTriangle aria-hidden className="size-3.5 text-studio-warning" />}
              </span>
              {showTarget && (
                <span
                  className={cn(
                    'w-20 shrink-0 text-right text-[11px]',
                    status === 'stale' || status === 'pending' ? 'text-studio-warning' : status === 'failed' ? 'text-studio-danger' : 'text-studio-muted',
                  )}
                  title={t?.error ?? undefined}
                >
                  {STATUS_LABEL[status]}
                </span>
              )}
              {showTarget && <TakeButton seg={s} lang={lang} />}
            </div>
          )
        })}
      </div>
    </div>
  )
}
