import { useState } from 'react'
import { ArrowDown, ArrowUp, MoreHorizontal, Plus, RefreshCcw, Sparkles, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/alert-dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

export interface ShotMenuProps {
  label: string
  canMoveUp: boolean
  canMoveDown: boolean
  stale: boolean
  onMove: (dir: -1 | 1) => void
  onInsertAfter: () => void
  onRewritePrompts: () => void
  onClearStale: () => void
  onDelete: () => void
}

// Row actions live in a menu so the row stays calm; every action is also reachable by keyboard here.
export function ShotMenu(p: ShotMenuProps) {
  const [confirm, setConfirm] = useState(false)
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon-sm" variant="ghost" aria-label={`Actions for shot ${p.label}`}>
            <MoreHorizontal aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem disabled={!p.canMoveUp} onSelect={() => p.onMove(-1)}>
            <ArrowUp aria-hidden />
            Move up
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!p.canMoveDown} onSelect={() => p.onMove(1)}>
            <ArrowDown aria-hidden />
            Move down
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={p.onInsertAfter}>
            <Plus aria-hidden />
            Insert shot after
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={p.onRewritePrompts}>
            <Sparkles aria-hidden />
            Rewrite prompts with AI
          </DropdownMenuItem>
          {p.stale && (
            <DropdownMenuItem onSelect={p.onClearStale}>
              <RefreshCcw aria-hidden />
              Clear stale
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem className="text-studio-danger" onSelect={() => setConfirm(true)}>
            <Trash2 aria-hidden />
            Delete shot
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        tone="danger"
        title={`Delete shot ${p.label}?`}
        description="Its frames and takes stay in history but leave the storyboard. A Continue seam on the next shot will link to the shot before instead."
        confirmLabel="Delete shot"
        onConfirm={p.onDelete}
      />
    </>
  )
}
