import { useId, useState } from 'react'
import { Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { fieldClass, Input } from '@/components/ui/input'
import { AerabButton } from '@/components/text/AerabButton'
import { useUpdateShot } from '@/hooks/useShots'
import { cleanLines } from '@/lib/shots'
import type { Character, DialogueLine, Shot } from '@/lib/types'
import { cn } from '@/lib/utils'
import { announce } from '@/stores/ui'

// contract-v26: the server keeps at most this many lines on a shot
export const MAX_LINES = 12

interface Row extends DialogueLine {
  key: number
}

// row keys only have to be unique while the editor is open
let lastKey = 0
const toRows = (lines: DialogueLine[]): Row[] => lines.map((l) => ({ ...l, key: ++lastKey }))

const sameLines = (a: DialogueLine[], b: DialogueLine[]) => JSON.stringify(cleanLines(a)) === JSON.stringify(cleanLines(b))

/** What the shot's characters say, one line per row, spoken in their voices and lip-synced to the take. */
export function ShotDialogue({ shot, label, cast }: { shot: Shot; label: string; cast: Character[] }) {
  const uid = useId()
  const update = useUpdateShot(shot.project_id)
  const server = shot.dialogue ?? []
  const [rows, setRows] = useState<Row[]>(() => toRows(server))
  const [seen, setSeen] = useState(shot.dialogue)
  // an AI storyboard or another tab changed the lines: show theirs unless they match what is here
  if (seen !== shot.dialogue) {
    setSeen(shot.dialogue)
    if (!sameLines(server, rows)) setRows(toRows(server))
  }

  const speakers = cast.filter((c) => shot.character_ids.includes(c.id))
  const nameOf = (id: string) => cast.find((c) => c.id === id)?.name ?? 'Someone'
  const talkers = new Set(cleanLines(rows).map((r) => r.character_id))

  const save = (list: Row[]) => {
    setRows(list)
    if (!sameLines(list, server)) update.mutate({ id: shot.id, patch: { dialogue: cleanLines(list) } })
  }
  const change = (key: number, patch: Partial<DialogueLine>, commit = false) => {
    const list = rows.map((r) => (r.key === key ? { ...r, ...patch } : r))
    if (commit) save(list)
    else setRows(list)
  }

  return (
    <section aria-labelledby={`${uid}-h`} className="flex flex-col gap-1.5">
      <h4 id={`${uid}-h`} className="section-label">
        Dialogue
      </h4>
      {rows.length > 0 && (
        <ol className="flex flex-col gap-1.5" aria-label={`Lines in shot ${label}`}>
          {rows.map((r, i) => (
            <li key={r.key} className="flex flex-wrap items-center gap-1.5">
              <label htmlFor={`${uid}-who-${r.key}`} className="sr-only">
                Speaker of line {i + 1}
              </label>
              <select
                id={`${uid}-who-${r.key}`}
                className={cn(fieldClass, 'h-7 w-32 text-small')}
                value={r.character_id}
                onChange={(e) => change(r.key, { character_id: e.target.value }, true)}
              >
                {speakers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <label htmlFor={`${uid}-text-${r.key}`} className="sr-only">
                Line {i + 1}, said by {nameOf(r.character_id)}
              </label>
              <Input
                id={`${uid}-text-${r.key}`}
                dir="auto"
                maxLength={600}
                value={r.text}
                placeholder="What they say"
                className="h-7 min-w-40 flex-1 text-small"
                onChange={(e) => change(r.key, { text: e.target.value })}
                onBlur={() => save(rows)}
              />
              <label htmlFor={`${uid}-pause-${r.key}`} className="sr-only">
                Pause after line {i + 1}, in seconds
              </label>
              <Input
                id={`${uid}-pause-${r.key}`}
                type="number"
                min={0}
                max={10}
                step={0.1}
                value={r.pause_after_s ?? ''}
                placeholder="Pause"
                title="Pause after this line, in seconds"
                className="h-7 w-20 text-small"
                onChange={(e) => change(r.key, { pause_after_s: e.target.value === '' ? null : Math.min(10, Math.max(0, Number(e.target.value))) })}
                onBlur={() => save(rows)}
              />
              <AerabButton
                text={r.text}
                onText={(t) => change(r.key, { text: t }, true)}
                target={`line ${i + 1}`}
                showNote={false}
                className="[&_button]:h-7"
              />
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="size-7"
                aria-label={`Remove line ${i + 1}`}
                onClick={() => {
                  save(rows.filter((x) => x.key !== r.key))
                  announce(`Line ${i + 1} removed.`)
                }}
              >
                <X aria-hidden />
              </Button>
            </li>
          ))}
        </ol>
      )}
      {speakers.length ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="self-start"
          disabled={rows.length >= MAX_LINES}
          onClick={() => setRows([...rows, { key: ++lastKey, character_id: speakers[0].id, text: '' }])}
        >
          <Plus aria-hidden />
          Add line
        </Button>
      ) : (
        <p className="text-small text-studio-muted">Put a character in the shot to give them lines.</p>
      )}
      {rows.length > 0 && (
        <p className={cn('text-small', talkers.size > 1 ? 'text-studio-text' : 'text-studio-muted')}>
          Lip sync works best with one visible speaker.
          {talkers.size > 1 && ' With two people talking, both mouths may move: try one shot per speaker, or an over-the-shoulder shot.'}
        </p>
      )}
      {shot.dialogue_notice && (
        <p role="note" className="rounded-[6px] border border-studio-border-strong bg-studio-raised px-2 py-1 text-small">
          {shot.dialogue_notice}
        </p>
      )}
    </section>
  )
}
