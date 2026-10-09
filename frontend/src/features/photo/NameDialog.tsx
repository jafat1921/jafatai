import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

interface Props {
  open: boolean
  title: string
  description?: string
  initial?: string
  confirm: string
  pending?: boolean
  error?: string | null
  onOpenChange: (open: boolean) => void
  onSubmit: (name: string) => void
}

/** One-field dialog: save a look, rename a look. */
export function NameDialog(props: Props) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-w-md">{props.open && <Body {...props} />}</DialogContent>
    </Dialog>
  )
}

function Body({ title, description, initial = '', confirm, pending, error, onOpenChange, onSubmit }: Props) {
  const [name, setName] = useState(initial)
  const ok = name.trim().length > 0
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (ok) onSubmit(name.trim())
      }}
      className="flex flex-col gap-3"
    >
      <DialogHeader className="mb-0">
        <DialogTitle>{title}</DialogTitle>
        {description && <DialogDescription>{description}</DialogDescription>}
      </DialogHeader>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="look-name">Name</Label>
        <Input id="look-name" autoFocus value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
      </div>
      {error && (
        <p role="alert" className="text-small text-studio-danger">
          {error}
        </p>
      )}
      <DialogFooter className="mt-0">
        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={!ok} loading={pending}>
          {confirm}
        </Button>
      </DialogFooter>
    </form>
  )
}
