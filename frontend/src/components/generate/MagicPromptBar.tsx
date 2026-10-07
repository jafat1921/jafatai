import { useId } from 'react'
import { Check, Sparkles, Undo2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { ApiError } from '@/lib/api'
import type { MagicMode } from '@/lib/types'
import type { MagicPrompt } from './useMagicPrompt'

const MODES: { value: MagicMode; label: string; hint: string }[] = [
  { value: 'auto', label: 'Auto', hint: 'Enhances short prompts, leaves detailed ones alone' },
  { value: 'on', label: 'On', hint: 'Always enrich the prompt before running' },
  { value: 'off', label: 'Off', hint: 'Send exactly what you wrote' },
]

function errorText(e: unknown) {
  if (e instanceof ApiError && (e.status === 404 || e.status === 405)) return "Prompt enhancement isn't available on this server yet."
  return e instanceof Error ? e.message : 'Could not enhance the prompt.'
}

export function MagicPromptBar({ magic, canPreview }: { magic: MagicPrompt; canPreview: boolean }) {
  const uid = useId()
  const { draft, stale } = magic
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span id={`${uid}-l`} className="flex items-center gap-1 text-small text-studio-muted">
          <Sparkles aria-hidden className="size-3.5 text-studio-accent-hover" />
          Magic prompt
        </span>
        <ToggleGroup type="single" aria-labelledby={`${uid}-l`} value={magic.mode} onValueChange={(v) => v && magic.setMode(v as MagicMode)} className="h-8">
          {MODES.map((m) => (
            <ToggleGroupItem key={m.value} value={m.value} title={m.hint} aria-label={`${m.label}: ${m.hint}`} className="h-6 px-2.5 text-small">
              {m.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        {magic.mode !== 'off' && (
          <Button type="button" size="sm" variant="ghost" disabled={!canPreview} loading={magic.previewing} onClick={magic.preview}>
            Preview enhancement
          </Button>
        )}
      </div>
      {magic.error != null && !draft && (
        <p className="text-small text-studio-muted" role="status">
          {errorText(magic.error)}
        </p>
      )}
      {draft && !magic.showPanel && (
        <p className="text-small text-studio-muted" role="status">
          Your prompt is already detailed, so it goes as written.
        </p>
      )}
      {magic.showPanel && draft && (
        <section aria-label="Enhanced prompt" className="flex flex-col gap-2 rounded-[6px] border border-studio-gold/60 bg-studio-raised p-2.5">
          <label htmlFor={`${uid}-t`} className="section-label">
            Enhanced prompt
          </label>
          <Textarea
            id={`${uid}-t`}
            dir="auto"
            rows={3}
            value={draft.text}
            onChange={(e) => magic.edit(e.target.value)}
            readOnly={draft.accepted && !stale}
            className="min-h-16 text-body"
          />
          {draft.notes && <p className="text-small text-studio-muted">{draft.notes}</p>}
          {stale ? (
            <p className="text-small text-studio-warning" role="status">
              You changed the prompt after this preview. Preview again, or it runs with Magic prompt {magic.mode === 'on' ? 'on' : 'on auto'}.
            </p>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              {draft.accepted ? (
                <>
                  <span className="inline-flex items-center gap-1 text-small text-studio-success" role="status">
                    <Check aria-hidden className="size-3.5" />
                    Runs with the enhanced prompt
                  </span>
                  <Button type="button" size="sm" variant="ghost" onClick={magic.undo}>
                    <Undo2 aria-hidden />
                    Edit again
                  </Button>
                </>
              ) : (
                <Button type="button" size="sm" variant="secondary" onClick={magic.accept}>
                  <Check aria-hidden />
                  Use enhanced prompt
                </Button>
              )}
              <Button type="button" size="sm" variant="ghost" onClick={magic.discard}>
                <X aria-hidden />
                Keep mine
              </Button>
            </div>
          )}
        </section>
      )}
    </div>
  )
}
