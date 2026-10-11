import { Undo2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAerab } from '@/hooks/useAerab'
import { aerabTerm } from '@/lib/aerab'
import { cn } from '@/lib/utils'

interface Props {
  text: string
  onText: (next: string) => void
  language?: string | null
  max?: number
  // e.g. "Add aerab to all lines" for a whole script
  label?: string
  // what the buttons act on, for their accessible names when a page has many ("line 3")
  target?: string
  // the result line under the buttons; a toolbar that is short on room can hide it (it is announced anyway)
  showNote?: boolean
  disabled?: boolean
  className?: string
}

/** "Add aerab" with one-step undo, for any field that can hold Urdu, Arabic, Persian... Hidden for other text. */
export function AerabButton({ text, onText, language, max, label, target, showNote = true, disabled, className }: Props) {
  const a = useAerab({ text, onText, language, max })
  if (!a.visible && !a.canUndo) return null
  const term = aerabTerm(language)
  return (
    <span className={cn('inline-flex flex-wrap items-center gap-1.5', className)}>
      {a.visible && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          loading={a.pending}
          disabled={disabled}
          onClick={a.run}
          aria-label={target ? `Add aerab to ${target}` : undefined}
          title={`Add the ${term === 'tashkeel' ? 'tashkeel (fatha, kasra, damma, sukun, shadda, tanwin)' : 'aerab (zabar, zer, pesh, jazm, tashdeed)'} so every word is pronounced. Your words are never changed.`}
        >
          <span aria-hidden lang="ur" className="font-[system-ui] text-[15px] leading-none">
            اَ
          </span>
          {label ?? 'Add aerab'}
        </Button>
      )}
      {a.canUndo && (
        <Button type="button" size="sm" variant="ghost" onClick={a.undo} aria-label={target ? `Undo aerab on ${target}` : undefined}>
          <Undo2 aria-hidden />
          Undo aerab
        </Button>
      )}
      {showNote && a.note && <span className="text-small text-studio-muted">{a.note}</span>}
    </span>
  )
}

/** The small "Aerab: on" line for a writer's dialog when its language is written in Arabic letters. */
export function AerabOnNote({ language, className }: { language?: string | null; className?: string }) {
  const term = aerabTerm(language)
  return (
    <p className={cn('text-[11px] text-studio-muted', className)}>
      <span className="font-medium text-studio-text">{term === 'tashkeel' ? 'Tashkeel' : 'Aerab'}: on.</span> The writer marks every
      word, and a second pass checks the marks, so speech and songs say the vowels right.
    </p>
  )
}
