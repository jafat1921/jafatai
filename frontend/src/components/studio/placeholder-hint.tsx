import { PenLine } from 'lucide-react'
import { placeholdersIn } from '@/lib/images'

/**
 * Template prompts carry [slots] like [product]. Lists the ones still in the text; clicking one
 * selects it in the field so typing replaces it.
 */
export function PlaceholderHint({ text, field }: { text: string; field: React.RefObject<HTMLTextAreaElement | null> }) {
  const slots = placeholdersIn(text)
  if (!slots.length) return null

  const select = (slot: string) => {
    const el = field.current
    if (!el) return
    const at = el.value.indexOf(slot)
    if (at < 0) return
    el.focus()
    el.setSelectionRange(at, at + slot.length)
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-[6px] border border-studio-warning/35 bg-studio-warning/5 px-2.5 py-1.5" role="status">
      <PenLine aria-hidden className="size-3.5 shrink-0 text-studio-warning" />
      <span className="text-small text-studio-warning">Replace the highlighted words with your own:</span>
      {slots.map((s) => (
        <button
          key={s}
          type="button"
          onClick={() => select(s)}
          className="rounded-[4px] border border-studio-gold bg-studio-gold/20 px-1.5 font-mono text-small text-studio-text hover:bg-studio-gold/35"
          aria-label={`Select ${s} in the prompt`}
        >
          {s}
        </button>
      ))}
    </div>
  )
}
