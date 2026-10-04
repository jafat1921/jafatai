import { useEffect, useState } from 'react'
import { AlignLeft, ChevronDown, Expand, Loader2, MessageSquareQuote, Minimize2, Palette, WandSparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Chip } from '@/components/studio/chip'
import { modKey } from '@/lib/keyboard'
import type { AssistAction } from '@/lib/types'

export type AssistRequest = { action: AssistAction; tone?: string }

const TONES = ['Tense', 'Melancholic', 'Hopeful', 'Comic', 'Eerie', 'Lyrical', 'Hard-boiled']

const ITEMS: { action: Exclude<AssistAction, 'draft_from_idea'>; label: string; icon: typeof Expand; hint: string }[] = [
  { action: 'expand', label: 'Expand', icon: Expand, hint: 'Deepen the action and beats' },
  { action: 'tighten', label: 'Tighten', icon: Minimize2, hint: 'Cut flab, keep every story point' },
  { action: 'rewrite_tone', label: 'Rewrite in tone…', icon: Palette, hint: 'Same events, new voice' },
  { action: 'write_dialogue', label: 'Write dialogue', icon: MessageSquareQuote, hint: 'Natural, specific lines' },
  { action: 'suggest_logline', label: 'Suggest logline', icon: AlignLeft, hint: 'One sentence from the script' },
]

function ToneDialog({ open, onOpenChange, onPick }: { open: boolean; onOpenChange: (o: boolean) => void; onPick: (tone: string) => void }) {
  const [tone, setTone] = useState('')
  const submit = (t: string) => {
    if (!t.trim()) return
    onPick(t.trim())
    setTone('')
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            submit(tone)
          }}
        >
          <DialogHeader>
            <DialogTitle>Rewrite in a tone</DialogTitle>
            <DialogDescription>Same events and characters, a different voice. You&apos;ll see the change before it&apos;s applied.</DialogDescription>
          </DialogHeader>
          <div className="mb-3 flex flex-wrap gap-1.5" role="group" aria-label="Common tones">
            {TONES.map((t) => (
              <Chip key={t} selected={tone === t} onClick={() => setTone(t)}>
                {t}
              </Chip>
            ))}
          </div>
          <Label htmlFor="assist-tone" className="mb-1.5">
            Tone
          </Label>
          <Input id="assist-tone" autoFocus value={tone} onChange={(e) => setTone(e.target.value)} placeholder="e.g. dry and deadpan" maxLength={100} />
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!tone.trim()}>
              Rewrite
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export interface AiAssistMenuProps {
  onAction: (req: AssistRequest) => void
  working?: boolean
  /** Live progress text while a request runs, e.g. "Expanding the scene… 12 s". */
  status?: string
  hasScript: boolean
}

export function AiAssistMenu({ onAction, working, status, hasScript }: AiAssistMenuProps) {
  const [open, setOpen] = useState(false)
  const [toneOpen, setToneOpen] = useState(false)

  // Ctrl+Shift+A from anywhere in the editor (PLAN 2b keyboard map)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'a' && !working) {
        e.preventDefault()
        setOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [working])

  if (working) {
    return (
      <span role="status" className="inline-flex max-w-72 items-center gap-1.5 text-small text-studio-muted">
        <Loader2 aria-hidden className="size-3.5 shrink-0 animate-spin text-studio-accent" />
        <span className="truncate">{status || 'AI is working…'}</span>
      </span>
    )
  }

  return (
    <>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <Button variant="secondary" size="sm" aria-keyshortcuts="Control+Shift+A">
            <WandSparkles aria-hidden />
            AI Assist
            <ChevronDown aria-hidden className="!size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuLabel>AI Assist</DropdownMenuLabel>
          {ITEMS.map(({ action, label, icon: Icon, hint }) => (
            <DropdownMenuItem
              key={action}
              disabled={!hasScript}
              onSelect={() => (action === 'rewrite_tone' ? setToneOpen(true) : onAction({ action }))}
            >
              <Icon aria-hidden />
              <span className="flex flex-col">
                <span>{label}</span>
                <span className="text-small text-studio-muted">{hint}</span>
              </span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <p className="px-2 py-1 text-small text-studio-muted">
            {hasScript ? 'Your text is never overwritten: changes come back as a suggestion.' : 'Write or draft the scene first.'}
            <span className="mt-0.5 block font-mono">{modKey}+Shift+A opens this menu</span>
          </p>
        </DropdownMenuContent>
      </DropdownMenu>
      <ToneDialog
        open={toneOpen}
        onOpenChange={setToneOpen}
        onPick={(tone) => {
          setToneOpen(false)
          onAction({ action: 'rewrite_tone', tone })
        }}
      />
    </>
  )
}
