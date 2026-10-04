import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { ErrorState } from '@/components/studio/states'
import { useSaveLocation } from '@/hooks/useLocations'
import type { Location } from '@/lib/types'

interface Props {
  projectId: string
  open: boolean
  // editing when set, adding otherwise
  location?: Location
  onOpenChange: (open: boolean) => void
  onSaved: (l: Location) => void
}

export function LocationDialog({ projectId, open, location, onOpenChange, onSaved }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {open && <Form projectId={projectId} location={location} onSaved={onSaved} onCancel={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  )
}

function Form({
  projectId,
  location,
  onSaved,
  onCancel,
}: {
  projectId: string
  location?: Location
  onSaved: Props['onSaved']
  onCancel: () => void
}) {
  const save = useSaveLocation(projectId)
  const [name, setName] = useState(location?.name ?? '')
  const [description, setDescription] = useState(location?.description ?? '')
  const verb = location ? 'Save location' : 'Add location'

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault()
        if (!name.trim()) return
        save.mutate({ id: location?.id, name: name.trim(), description: description.trim() }, { onSuccess: onSaved })
      }}
    >
      <DialogHeader className="mb-0">
        <DialogTitle>{location ? 'Edit location' : 'Add location'}</DialogTitle>
        <DialogDescription>Describe the place as a camera would see it. This seeds the establishing frame.</DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="loc-name">Name</Label>
        <Input id="loc-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Harbour at dawn" />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="loc-desc">Description</Label>
        <Textarea
          id="loc-desc"
          rows={4}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Weathered stone quay, fishing boats moored in mist, gulls on bollards, cold blue light."
        />
      </div>
      {save.isError && <ErrorState compact title="Couldn't save the location" error={save.error} />}
      <DialogFooter className="mt-0">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={!name.trim()} loading={save.isPending}>
          {verb}
        </Button>
      </DialogFooter>
    </form>
  )
}
