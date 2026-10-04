import { useEffect, useMemo } from 'react'
import { Check, Sparkles, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { ErrorState } from '@/components/studio/states'
import { wordDiff } from '@/lib/diff'
import { modKey } from '@/lib/keyboard'
import type { Suggestion } from '@/lib/types'
import { cn } from '@/lib/utils'

const ACTION_LABELS: Record<string, string> = {
  expand: 'Expand',
  tighten: 'Tighten',
  rewrite_tone: 'Rewrite in tone',
  write_dialogue: 'Write dialogue',
  suggest_logline: 'Suggest logline',
  draft_from_idea: 'Draft from idea',
  write_missing: 'Write missing scenes',
  extract: 'Character description',
  outline: 'AI Director',
}

const FIELD_LABELS: Record<string, string> = {
  script_text: 'script',
  logline: 'logline',
  heading: 'heading',
  description: 'description',
}

// Esc belongs to whatever overlay is open; only take it when nothing else would.
const overlayOpen = () => !!document.querySelector('[role="menu"], [role="dialog"], [role="listbox"]')

export interface SuggestionCardProps {
  suggestion: Suggestion
  /** Live text of the field; the diff is shown against this rather than the snapshot. */
  currentText?: string
  onAccept: () => void
  onReject: () => void
  busy?: boolean
  error?: unknown
  /** Only one card on screen should own the Ctrl+Enter / Esc shortcuts. */
  shortcuts?: boolean
}

export function SuggestionCard({ suggestion, currentText, onAccept, onReject, busy, error, shortcuts = true }: SuggestionCardProps) {
  const before = currentText ?? suggestion.current_text
  const parts = useMemo(() => wordDiff(before, suggestion.proposed_text), [before, suggestion.proposed_text])
  const label = ACTION_LABELS[suggestion.action] ?? 'AI'
  const field = FIELD_LABELS[suggestion.field] ?? suggestion.field

  useEffect(() => {
    if (!shortcuts || busy) return
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        onAccept()
      } else if (e.key === 'Escape' && !overlayOpen()) {
        e.preventDefault()
        onReject()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [shortcuts, busy, onAccept, onReject])

  return (
    <section
      aria-label={`AI suggestion: ${label}, changes the ${field}`}
      className="rounded-[6px] border border-studio-accent/60 bg-studio-raised shadow-card"
    >
      <header className="flex flex-wrap items-center gap-2 border-b border-studio-border px-3 py-2">
        <Sparkles aria-hidden className="size-4 text-studio-accent" />
        <h2 className="text-body font-medium">
          AI suggestion: {label}
          <span className="ml-1.5 text-small font-normal text-studio-muted">· {field}</span>
        </h2>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="primary" onClick={onAccept} loading={busy} aria-keyshortcuts="Control+Enter">
            <Check aria-hidden />
            Accept
            {shortcuts && <Kbd>{modKey}+Enter</Kbd>}
          </Button>
          <Button size="sm" variant="secondary" onClick={onReject} disabled={busy} aria-keyshortcuts="Escape">
            <X aria-hidden />
            Reject
            {shortcuts && <Kbd>Esc</Kbd>}
          </Button>
        </div>
      </header>
      <div
        className={cn(
          'max-h-72 overflow-y-auto whitespace-pre-wrap px-4 py-3 leading-[22px]',
          suggestion.field === 'script_text' ? 'font-script text-[14px]' : 'text-body',
        )}
      >
        {parts.map((p, i) =>
          p.type === 'same' ? (
            <span key={i}>{p.text}</span>
          ) : p.type === 'add' ? (
            <ins key={i} className="rounded-[2px] bg-studio-success/12 text-studio-success underline decoration-studio-success underline-offset-2">
              <span className="sr-only">added: </span>
              {p.text}
            </ins>
          ) : (
            <del key={i} className="rounded-[2px] bg-studio-danger/10 text-studio-danger">
              <span className="sr-only">removed: </span>
              {p.text}
            </del>
          ),
        )}
      </div>
      {error ? (
        <div className="px-3 pb-3">
          <ErrorState compact title="Couldn't apply that" error={error} />
        </div>
      ) : null}
    </section>
  )
}
