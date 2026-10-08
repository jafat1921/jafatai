import { useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { mediaAlt } from '@/lib/media'
import type { MediaItem } from '@/lib/types'

interface Props {
  item: MediaItem | null
  pending?: boolean
  error?: string | null
  onOpenChange: (open: boolean) => void
  onRename: (title: string) => void
}

export function RenameDialog({ item, pending, error, onOpenChange, onRename }: Props) {
  return (
    <Dialog open={!!item} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">{item && <RenameForm key={item.id} item={item} pending={pending} error={error} onRename={onRename} onCancel={() => onOpenChange(false)} />}</DialogContent>
    </Dialog>
  )
}

function RenameForm({ item, pending, error, onRename, onCancel }: Omit<Props, 'item' | 'onOpenChange'> & { item: MediaItem; onCancel: () => void }) {
  const id = useId()
  const [title, setTitle] = useState(item.title || mediaAlt(item))
  const blank = !title.trim()
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault()
        if (!blank) onRename(title.trim())
      }}
    >
      <DialogHeader className="mb-0">
        <DialogTitle>Rename</DialogTitle>
        <DialogDescription>The name shows under the picture and in search.</DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={id}>Name</Label>
        <Input id={id} value={title} maxLength={300} autoFocus onChange={(e) => setTitle(e.target.value)} aria-invalid={blank || undefined} />
        {error && (
          <p role="alert" className="text-small text-studio-danger">
            {error}
          </p>
        )}
      </div>
      <DialogFooter className="mt-0">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={blank} loading={pending}>
          Save name
        </Button>
      </DialogFooter>
    </form>
  )
}
