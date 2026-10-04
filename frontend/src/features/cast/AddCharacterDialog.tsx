import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { ErrorState } from '@/components/studio/states'
import { useCreateCharacter } from '@/hooks/useCharacters'
import type { Character } from '@/lib/types'

interface Props {
  projectId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (c: Character) => void
}

export function AddCharacterDialog({ projectId, open, onOpenChange, onCreated }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>{open && <Form projectId={projectId} onCreated={onCreated} onCancel={() => onOpenChange(false)} />}</DialogContent>
    </Dialog>
  )
}

function Form({ projectId, onCreated, onCancel }: { projectId: string; onCreated: Props['onCreated']; onCancel: () => void }) {
  const create = useCreateCharacter(projectId)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault()
        if (!name.trim()) return
        create.mutate({ name: name.trim(), description: description.trim() || undefined }, { onSuccess: onCreated })
      }}
    >
      <DialogHeader className="mb-0">
        <DialogTitle>Add character</DialogTitle>
        <DialogDescription>Describe how they look. The description seeds the portrait prompt.</DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="char-name">Name</Label>
        <Input id="char-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Mara" />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="char-desc">Description</Label>
        <Textarea
          id="char-desc"
          rows={4}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Marine biologist in her 40s, short grey hair, weathered wetsuit, calm and watchful."
        />
      </div>
      {create.isError && <ErrorState compact title="Couldn't add the character" error={create.error} />}
      <DialogFooter className="mt-0">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={!name.trim()} loading={create.isPending}>
          Add character
        </Button>
      </DialogFooter>
    </form>
  )
}
