import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { GROUP_KEYS, GROUP_LABELS, modifiedGroups } from '@/lib/photo/workflow'
import type { DevelopParams } from '@/lib/photo/types'

interface Props {
  mode: 'copy' | 'sync' | null
  params: DevelopParams
  initial: string[]
  count: number
  onClose: () => void
  onConfirm: (groups: string[]) => void
}

/** Lightroom's Copy Settings / Synchronize Settings: pick the groups that travel. */
export function CopySettingsDialog({ mode, params, initial, count, onClose, onConfirm }: Props) {
  return (
    <Dialog open={!!mode} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">{mode && <Body key={mode} mode={mode} params={params} initial={initial} count={count} onClose={onClose} onConfirm={onConfirm} />}</DialogContent>
    </Dialog>
  )
}

function Body({ mode, params, initial, count, onClose, onConfirm }: Omit<Props, 'mode'> & { mode: 'copy' | 'sync' }) {
  const [groups, setGroups] = useState<string[]>(initial)
  const all = Object.keys(GROUP_KEYS)
  const modified = new Set(modifiedGroups(params))
  return (
    <>
      <DialogHeader>
        <DialogTitle>{mode === 'copy' ? 'Copy settings' : `Sync settings to ${count} photos`}</DialogTitle>
        <DialogDescription>
          {mode === 'copy'
            ? 'Pick what to copy. Paste (Ctrl+Shift+V) puts these groups on another photo and leaves the rest of it alone.'
            : 'Each photo keeps its own settings for anything not ticked. Every photo gets a new version; nothing is overwritten.'}
        </DialogDescription>
      </DialogHeader>
      <div className="mt-2 flex gap-2 text-small">
        <button type="button" className="text-studio-accent hover:underline" onClick={() => setGroups(all)}>Check all</button>
        <button type="button" className="text-studio-accent hover:underline" onClick={() => setGroups([])}>Check none</button>
        <button type="button" className="text-studio-accent hover:underline" onClick={() => setGroups(all.filter((g) => modified.has(g)))}>Only what's changed</button>
      </div>
      <fieldset className="mt-2 flex flex-col gap-1.5">
        <legend className="sr-only">Settings groups</legend>
        {all.map((g) => (
          <label key={g} className="flex items-center gap-2 text-small">
            <input type="checkbox" checked={groups.includes(g)} onChange={(e) => setGroups((x) => (e.target.checked ? [...x, g] : x.filter((y) => y !== g)))} />
            <span className={modified.has(g) ? 'font-medium' : 'text-studio-muted'}>{GROUP_LABELS[g]}</span>
          </label>
        ))}
      </fieldset>
      <DialogFooter className="mt-3">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!groups.length} onClick={() => onConfirm(groups)}>
          {mode === 'copy' ? 'Copy' : `Sync ${count} photos`}
        </Button>
      </DialogFooter>
    </>
  )
}
