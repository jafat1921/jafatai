import { useId, useState } from 'react'
import { FastForward, Scissors } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { fieldClass } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { ErrorState } from '@/components/studio/states'
import { formatDuration, LONGTAKE_MAX_S } from '@/lib/duration'
import type { Shot } from '@/lib/types'
import { cn } from '@/lib/utils'
import { splitDurations, splitText } from './shotList'

interface SplitProps {
  shot: Shot | null
  label: string
  pending?: boolean
  error?: unknown
  onOpenChange: (open: boolean) => void
  onSubmit: (body: { at_ratio: number; descriptions: [string, string] }) => void
}

export function SplitShotDialog(props: SplitProps) {
  return (
    <Dialog open={!!props.shot} onOpenChange={props.onOpenChange}>
      <DialogContent>{props.shot && <SplitForm {...props} shot={props.shot} />}</DialogContent>
    </Dialog>
  )
}

function SplitForm({ shot, label, pending, error, onOpenChange, onSubmit }: SplitProps & { shot: Shot }) {
  const uid = useId()
  const [ratio, setRatio] = useState(0.5)
  // the two halves follow the slider until the user types in them
  const [texts, setTexts] = useState<[string, string] | null>(null)
  const shown = texts ?? splitText(shot.description, ratio)
  const [a, b] = splitDurations(shot.duration_s, ratio)

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit({ at_ratio: ratio, descriptions: [shown[0].trim() || shot.description, shown[1].trim() || shot.description] })
      }}
    >
      <DialogHeader className="mb-0">
        <DialogTitle>Split shot {label}</DialogTitle>
        <DialogDescription>
          Two shots from one. The second continues straight on from the first (a Continue seam), so it opens on the first
          one&apos;s END frame.
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${uid}-r`} className="section-label">
          Cut at
        </label>
        <input
          id={`${uid}-r`}
          type="range"
          min={0.1}
          max={0.9}
          step={0.05}
          value={ratio}
          onChange={(e) => setRatio(Number(e.target.value))}
          aria-valuetext={`${formatDuration(a)} then ${formatDuration(b)}`}
          className="accent-[var(--accent)]"
        />
        <p className="font-mono text-small text-studio-muted" aria-live="polite">
          {formatDuration(a)} + {formatDuration(b)}
        </p>
      </div>
      {(['First', 'Second'] as const).map((name, i) => (
        <div key={name} className="flex flex-col gap-1">
          <label htmlFor={`${uid}-${i}`} className="section-label">
            {name} shot
          </label>
          <Textarea
            id={`${uid}-${i}`}
            className="min-h-16 text-small"
            value={shown[i]}
            onChange={(e) => setTexts(i === 0 ? [e.target.value, shown[1]] : [shown[0], e.target.value])}
          />
        </div>
      ))}
      {error ? <ErrorState compact title="Couldn't split the shot" error={error} /> : null}
      <DialogFooter className="mt-0">
        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={pending}>
          <Scissors aria-hidden />
          Split
        </Button>
      </DialogFooter>
    </form>
  )
}

interface ExtendProps {
  shot: Shot | null
  label: string
  pending?: boolean
  error?: unknown
  onOpenChange: (open: boolean) => void
  onSubmit: (body: { duration_s: number; prompt?: string }) => void
}

export function ExtendShotDialog(props: ExtendProps) {
  return (
    <Dialog open={!!props.shot} onOpenChange={props.onOpenChange}>
      <DialogContent>{props.shot && <ExtendForm {...props} />}</DialogContent>
    </Dialog>
  )
}

function ExtendForm({ label, pending, error, onOpenChange, onSubmit }: ExtendProps) {
  const uid = useId()
  const [seconds, setSeconds] = useState('5')
  const [prompt, setPrompt] = useState('')
  const n = Number(seconds)
  const bad = !Number.isFinite(n) || n < 1 || n > LONGTAKE_MAX_S

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault()
        if (!bad) onSubmit({ duration_s: Math.round(n * 2) / 2, prompt: prompt.trim() || undefined })
      }}
    >
      <DialogHeader className="mb-0">
        <DialogTitle>Extend shot {label}</DialogTitle>
        <DialogDescription>
          Adds the next beat as a new shot right after this one. It opens on this shot&apos;s END frame, and the AI writes what
          happens next. Nothing is rendered until you generate its END frame.
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${uid}-s`} className="section-label">
          Length (seconds)
        </label>
        <input
          id={`${uid}-s`}
          type="number"
          min={1}
          max={LONGTAKE_MAX_S}
          step={0.5}
          value={seconds}
          aria-invalid={bad || undefined}
          aria-describedby={bad ? `${uid}-e` : undefined}
          onChange={(e) => setSeconds(e.target.value)}
          className={cn(fieldClass, 'h-8 w-24 font-mono')}
        />
        {bad && (
          <p id={`${uid}-e`} className="text-small text-studio-danger">
            Between 1 and {LONGTAKE_MAX_S} seconds.
          </p>
        )}
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${uid}-p`} className="section-label">
          What happens next (optional)
        </label>
        <Textarea
          id={`${uid}-p`}
          className="min-h-16"
          placeholder="Leave empty and the AI picks the next beat from the script"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
      </div>
      {error ? <ErrorState compact title="Couldn't extend the shot" error={error} /> : null}
      <DialogFooter className="mt-0">
        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={pending} disabled={bad}>
          <FastForward aria-hidden />
          Extend shot
        </Button>
      </DialogFooter>
    </form>
  )
}
