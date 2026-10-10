import { useDeferredValue, useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { NARRATOR, splitPreview, type CastMember, type SplitMode } from '@/lib/dialogue'
import { SELECT } from '../voice/AddVoiceDialog'

const MODES: { value: SplitMode; label: string; hint: string }[] = [
  { value: 'sentences', label: 'Sentences', hint: 'One line per sentence' },
  { value: 'paragraphs', label: 'Paragraphs', hint: 'One line per paragraph or speech' },
  { value: 'lines', label: 'Lines', hint: 'One line per line of text' },
]
const PREVIEW_MAX = 60

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  cast: CastMember[]
  onSplit: (body: { text: string; mode: SplitMode; speaker_id: string }) => void
  pending: boolean
  error: string | null
}

export function PasteSplitDialog({ open, onOpenChange, cast, onSplit, pending, error }: Props) {
  const uid = useId()
  const [text, setText] = useState('')
  const [mode, setMode] = useState<SplitMode>('sentences')
  const [speaker, setSpeaker] = useState(NARRATOR)
  const deferred = useDeferredValue(text)
  const defaultName = cast.find((c) => c.id === speaker)?.name ?? 'Narrator'
  const preview = splitPreview(deferred, mode, defaultName)
  const known = new Set(cast.map((c) => c.name.toLowerCase()))
  const newNames = [...new Set(preview.map((p) => p.speaker))].filter((n) => !known.has(n.toLowerCase()))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Paste & split</DialogTitle>
          <DialogDescription>
            Lines that start with <code className="font-mono">NAME:</code> or sit under a screenplay cue go to that character; new names join the cast.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="flex flex-col gap-3">
            <label htmlFor={`${uid}-text`} className="section-label">
              Text
            </label>
            <Textarea
              id={`${uid}-text`}
              dir="auto"
              rows={12}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={'Narrator: The rain had not stopped.\nMaya: We should go.\nTomas: Not yet.'}
              className="font-script text-small"
            />
            <div>
              <div id={`${uid}-mode`} className="section-label mb-1.5">
                Split into
              </div>
              <ToggleGroup type="single" aria-labelledby={`${uid}-mode`} value={mode} onValueChange={(v) => v && setMode(v as SplitMode)}>
                {MODES.map((m) => (
                  <ToggleGroupItem key={m.value} value={m.value} title={m.hint} className="px-3">
                    {m.label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>
            <label className="flex flex-col gap-1 text-small">
              <span className="section-label">Unattributed text goes to</span>
              <select value={speaker} onChange={(e) => setSpeaker(e.target.value)} className={SELECT}>
                {cast.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <section aria-labelledby={`${uid}-preview`} className="flex min-h-0 flex-col gap-2">
            <h3 id={`${uid}-preview`} className="section-label">
              Preview · {preview.length} line{preview.length === 1 ? '' : 's'}
            </h3>
            {newNames.length > 0 && <p className="text-[11px] text-studio-muted">New in the cast: {newNames.join(', ')}</p>}
            <ol aria-label="Split preview" className="max-h-80 overflow-y-auto rounded-[6px] border border-studio-border bg-studio-raised text-small">
              {preview.slice(0, PREVIEW_MAX).map((p, i) => (
                <li key={i} className="flex gap-2 border-b border-studio-border px-2 py-1 last:border-b-0">
                  <span className="w-20 shrink-0 truncate font-medium">{p.speaker}</span>
                  <span dir="auto" className="min-w-0 flex-1">
                    {p.emotion && <span className="text-studio-muted">({p.emotion}) </span>}
                    {p.text}
                  </span>
                </li>
              ))}
              {preview.length === 0 && <li className="px-2 py-3 text-studio-muted">Paste some text to see how it splits.</li>}
              {preview.length > PREVIEW_MAX && <li className="px-2 py-1 text-studio-muted">…and {preview.length - PREVIEW_MAX} more</li>}
            </ol>
          </section>
        </div>
        {error && (
          <p role="alert" className="mt-3 text-small text-studio-danger">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={preview.length === 0}
            loading={pending}
            onClick={() => onSplit({ text, mode, speaker_id: speaker })}
          >
            Add {preview.length || ''} line{preview.length === 1 ? '' : 's'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
