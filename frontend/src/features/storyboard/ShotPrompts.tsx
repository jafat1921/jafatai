import { useState } from 'react'
import { Loader2, Lock, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/alert-dialog'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { ErrorState } from '@/components/studio/states'
import { useUpdateShot } from '@/hooks/useShots'
import type { PromptMode, Shot } from '@/lib/types'
import { useRewritePrompts } from './useRewritePrompts'

type Field = 'start_prompt' | 'end_prompt' | 'motion_prompt'

const FIELDS: { field: Field; label: string; hint: string }[] = [
  { field: 'start_prompt', label: 'START frame', hint: 'How the shot opens' },
  { field: 'end_prompt', label: 'END frame', hint: 'How it ends' },
  { field: 'motion_prompt', label: 'Motion', hint: 'What happens in between (drives the video take)' },
]

function PromptField({ shot, field, label, hint, onSave }: { shot: Shot; field: Field; label: string; hint: string; onSave: (v: string) => void }) {
  const server = shot[field] ?? ''
  const [draft, setDraft] = useState(server)
  const [seen, setSeen] = useState(server)
  // a compile job finishing replaces the text; take it unless there are unsaved edits
  if (server !== seen) {
    setSeen(server)
    if (draft === seen) setDraft(server)
  }
  const id = `${field}-${shot.id}`
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2">
        <Label htmlFor={id}>{label}</Label>
        <span className="text-small text-studio-muted">{hint}</span>
      </div>
      <Textarea
        id={id}
        rows={3}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => draft !== server && onSave(draft)}
        placeholder={shot.prompt_mode === 'auto' ? 'Written by the AI when frames are generated' : undefined}
        className="text-small"
      />
    </div>
  )
}

export function ShotPrompts({ shot }: { shot: Shot }) {
  const update = useUpdateShot(shot.project_id)
  const rewrite = useRewritePrompts(shot)

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <ToggleGroup
          type="single"
          value={shot.prompt_mode}
          aria-label="Prompt mode"
          onValueChange={(v) => v && update.mutate({ id: shot.id, patch: { prompt_mode: v as PromptMode } })}
        >
          <ToggleGroupItem value="auto">
            <Sparkles aria-hidden />
            Auto
          </ToggleGroupItem>
          <ToggleGroupItem value="manual">
            <Lock aria-hidden />
            Manual
          </ToggleGroupItem>
        </ToggleGroup>
        <Button size="sm" variant="secondary" onClick={rewrite.request} disabled={rewrite.working}>
          {rewrite.working ? <Loader2 aria-hidden className="animate-spin" /> : <Sparkles aria-hidden />}
          Rewrite prompts with AI
        </Button>
      </div>
      <p className="text-small text-studio-muted">
        {shot.prompt_mode === 'auto'
          ? 'Auto: the AI writes these from the script, cast and location. Editing one switches the shot to Manual.'
          : 'Manual: your prompts are used as written and the AI leaves them alone.'}
      </p>
      <p role="status" className="text-small text-studio-muted empty:hidden">
        {rewrite.status}
      </p>
      {FIELDS.map((f) => (
        <PromptField
          key={f.field}
          shot={shot}
          {...f}
          // contract: editing a prompt sets prompt_mode=manual server-side; mirror it so the toggle updates now
          onSave={(v) => update.mutate({ id: shot.id, patch: { [f.field]: v, prompt_mode: 'manual' } })}
        />
      ))}
      {rewrite.error || update.error ? (
        <ErrorState compact title="That didn't work" error={rewrite.error ?? update.error} />
      ) : null}
      <ConfirmDialog
        open={rewrite.confirming}
        onOpenChange={rewrite.setConfirming}
        title="Replace your hand-written prompts?"
        description="This shot's prompts are manual. Rewriting switches it back to Auto and the AI replaces all three prompts."
        confirmLabel="Switch to Auto and rewrite"
        onConfirm={rewrite.confirm}
      />
    </div>
  )
}
