import { useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Kbd } from '@/components/ui/kbd'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { modKey } from '@/lib/keyboard'

interface Props {
  mode: 'note' | 'edit' | null
  initialPrompt: string
  onOpenChange: (open: boolean) => void
  onSubmit: (value: { note?: string; prompt?: string }) => void
  pending?: boolean
}

export function RegenerateDialog({ mode, initialPrompt, onOpenChange, onSubmit, pending }: Props) {
  return (
    <Dialog open={mode !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        {/* keyed so the fields reset every time the dialog opens */}
        {mode && <RegenerateForm key={mode} mode={mode} initialPrompt={initialPrompt} onSubmit={onSubmit} pending={pending} />}
      </DialogContent>
    </Dialog>
  )
}

function RegenerateForm({
  mode,
  initialPrompt,
  onSubmit,
  pending,
}: {
  mode: 'note' | 'edit'
  initialPrompt: string
  onSubmit: Props['onSubmit']
  pending?: boolean
}) {
  const [text, setText] = useState(mode === 'edit' ? initialPrompt : '')
  const canSubmit = text.trim().length > 0 && !pending

  const submit = () => {
    if (!canSubmit) return
    onSubmit(mode === 'note' ? { note: text.trim() } : { prompt: text.trim() })
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <DialogHeader>
        <DialogTitle>{mode === 'note' ? 'Regenerate with a note' : 'Edit & regenerate'}</DialogTitle>
        <DialogDescription>
          {mode === 'note'
            ? 'Say what to change. A new version is created; this one stays in history.'
            : 'Adjust the prompt directly. A new version is created; this one stays in history.'}
        </DialogDescription>
      </DialogHeader>
      <Label htmlFor="regen-text" className="mb-1.5">
        {mode === 'note' ? 'Note' : 'Prompt'}
      </Label>
      <Textarea
        id="regen-text"
        autoFocus
        rows={mode === 'note' ? 3 : 6}
        value={text}
        placeholder={mode === 'note' ? 'e.g. hair should be grey, less smiling' : undefined}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault()
            submit()
          }
        }}
      />
      <DialogFooter>
        <Button type="submit" variant="primary" disabled={!canSubmit} loading={pending}>
          <RefreshCw aria-hidden />
          Regenerate
          <Kbd>{modKey}+Enter</Kbd>
        </Button>
      </DialogFooter>
    </form>
  )
}
