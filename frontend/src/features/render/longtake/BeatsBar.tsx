import { useState } from 'react'
import { Check, ImageOff, Lock, LockOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { fmtT } from '@/lib/longtake'
import type { Beat } from '@/lib/types'
import { cn } from '@/lib/utils'

function FrameMarker({ side, approved, at }: { side: 'START' | 'END'; approved: boolean; at: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-small',
        approved ? 'text-studio-success' : 'text-studio-muted',
        side === 'END' && 'flex-row-reverse',
      )}
    >
      {approved ? <Check aria-hidden className="size-3" /> : <ImageOff aria-hidden className="size-3" />}
      <span>
        {side} {at}
        <span className="sr-only">{approved ? ', approved frame' : ', no approved frame'}</span>
      </span>
    </span>
  )
}

interface Props {
  beats: Beat[]
  durationS: number
  label: string
  startApproved: boolean
  endApproved: boolean
  selected: number
  onSelect: (index: number) => void
}

/** Timeline 0..duration with one segment per beat, START and END frame markers at the ends. */
export function BeatsBar({ beats, durationS, label, startApproved, endApproved, selected, onSelect }: Props) {
  const move = (e: React.KeyboardEvent, i: number) => {
    const next = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : -1
    if (next < 0 || next >= beats.length) return
    e.preventDefault()
    onSelect(next)
    const el = e.currentTarget.parentElement?.children[next] as HTMLElement | undefined
    el?.focus()
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex justify-between">
        <FrameMarker side="START" approved={startApproved} at="0 s" />
        <FrameMarker side="END" approved={endApproved} at={fmtT(durationS)} />
      </div>
      <div className="relative flex h-10 overflow-hidden rounded-[4px] border border-studio-border-strong bg-studio-raised">
        <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 bg-studio-gold" />
        {beats.length === 0 ? (
          <span className="flex flex-1 items-center justify-center text-small text-studio-muted">No beats yet</span>
        ) : (
          <div role="group" aria-label={`Beats of shot ${label}`} className="flex flex-1">
            {beats.map((b, i) => (
              <button
                key={i}
                type="button"
                aria-pressed={selected === i}
                aria-label={`Beat ${i + 1}, ${fmtT(b.t_start)} to ${fmtT(b.t_end)}${b.locked ? ', locked' : ''}: ${b.prompt || 'empty'}`}
                tabIndex={selected === i ? 0 : -1}
                onClick={() => onSelect(i)}
                onKeyDown={(e) => move(e, i)}
                style={{ flexGrow: Math.max(0.1, b.t_end - b.t_start), flexBasis: 0 }}
                className={cn(
                  'relative flex min-w-5 items-center justify-center gap-0.5 border-r border-studio-border-strong px-1 text-small last:border-r-0',
                  selected === i ? 'bg-studio-accent text-studio-accent-fg' : 'text-studio-text hover:bg-studio-panel-hover',
                )}
              >
                <span className="font-mono">{i + 1}</span>
                {b.locked && <Lock aria-hidden className="size-3" />}
              </button>
            ))}
          </div>
        )}
        <span aria-hidden className="absolute inset-y-0 right-0 w-0.5 bg-studio-gold" />
      </div>
    </div>
  )
}

/** Text of the selected beat. Saving locks it; Unlock lets "Write beats with AI" rewrite it again. */
export function BeatEditor({
  beat,
  index,
  onSave,
  onLock,
  saving,
}: {
  beat: Beat
  index: number
  onSave: (prompt: string) => void
  onLock: (locked: boolean) => void
  saving?: boolean
}) {
  const [draft, setDraft] = useState(beat.prompt)
  const [seen, setSeen] = useState(beat.prompt)
  if (beat.prompt !== seen) {
    setSeen(beat.prompt)
    setDraft(beat.prompt)
  }
  const id = `beat-${index}`

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <label htmlFor={id} className="section-label flex-1">
          Beat {index + 1} · {fmtT(beat.t_start)}–{fmtT(beat.t_end)}
        </label>
        {beat.locked ? (
          <>
            <span className="inline-flex items-center gap-1 text-small text-studio-muted">
              <Lock aria-hidden className="size-3" />
              Locked
            </span>
            <Button size="sm" variant="ghost" className="h-6 px-1.5" onClick={() => onLock(false)} disabled={saving}>
              <LockOpen aria-hidden />
              Unlock
            </Button>
          </>
        ) : (
          <span className="text-small text-studio-muted">
            {beat.stale ? 'Out of date, rewritten on next render' : beat.source === 'ai' ? 'AI' : 'Yours'}
          </span>
        )}
      </div>
      <Textarea
        id={id}
        rows={3}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => draft.trim() !== beat.prompt && onSave(draft.trim())}
        placeholder="What happens during this part of the take?"
        className="text-small"
      />
      <p className="text-small text-studio-muted">Your edits lock the beat so the AI keeps it.</p>
    </div>
  )
}
