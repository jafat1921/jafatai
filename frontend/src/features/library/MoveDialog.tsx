import { useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { Folder } from '@/lib/types'
import { plural } from '@/lib/utils'
import { flatTree } from '@/lib/folders'

interface Props {
  open: boolean
  count: number
  folders: Folder[]
  current: string | null
  rootLabel: string
  onOpenChange: (open: boolean) => void
  onMove: (folderId: string | null) => void
}

/** The keyboard way to file things (M): a radio list of folders; arrows pick, Enter moves. */
export function MoveDialog({ open, count, folders, current, rootLabel, onOpenChange, onMove }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">{open && <MoveForm count={count} folders={folders} current={current} rootLabel={rootLabel} onMove={onMove} onCancel={() => onOpenChange(false)} />}</DialogContent>
    </Dialog>
  )
}

const ROOT = '__root__'

function MoveForm({ count, folders, current, rootLabel, onMove, onCancel }: Omit<Props, 'open' | 'onOpenChange'> & { onCancel: () => void }) {
  const name = useId()
  const rows = flatTree(folders)
  const [pick, setPick] = useState<string>(rows.find((r) => r.folder.id !== current)?.folder.id ?? ROOT)
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault()
        onMove(pick === ROOT ? null : pick)
      }}
    >
      <DialogHeader className="mb-0">
        <DialogTitle>Move {plural(count, 'item')}</DialogTitle>
        <DialogDescription>Pick a folder. Project results are filed by reference; nothing is copied.</DialogDescription>
      </DialogHeader>
      <fieldset className="flex max-h-72 flex-col gap-0.5 overflow-y-auto rounded-[6px] border border-studio-border p-1">
        <legend className="sr-only">Folder</legend>
        {[{ id: ROOT, label: `${rootLabel} (no folder)`, depth: 0 }, ...rows.map((r) => ({ id: r.folder.id, label: r.folder.name, depth: r.depth }))].map((o) => (
          <label key={o.id} className="flex cursor-pointer items-center gap-2 rounded-[4px] px-2 py-1.5 text-body hover:bg-studio-panel-hover has-[:checked]:bg-studio-accent-soft" style={{ paddingLeft: 8 + o.depth * 16 }}>
            <input type="radio" name={name} value={o.id} checked={pick === o.id} onChange={() => setPick(o.id)} className="accent-[var(--accent)]" />
            <span className="truncate">{o.label}</span>
            {o.id === (current ?? ROOT) && <span className="ml-auto text-small text-studio-muted">here now</span>}
          </label>
        ))}
      </fieldset>
      <DialogFooter className="mt-0">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary">
          Move here
        </Button>
      </DialogFooter>
    </form>
  )
}
