import { useId, useRef, useState } from 'react'
import { ImagePlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { ErrorState } from '@/components/studio/states'
import { useCharacterFromPhoto, useCreateStudioCharacter } from '@/hooks/useCharacterStudio'
import { acceptFor, checkFile, uploadMedia } from '@/lib/upload'
import type { Character, MediaItem } from '@/lib/types'

// the server checks this exact sentence, like the voice clone consent
export const PHOTO_CONSENT = 'I have the right to use this photo, and the person in it agreed to it being made into a character.'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (c: Character) => void
}

export function NewCharacterDialog({ open, onOpenChange, onCreated }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New character</DialogTitle>
          <DialogDescription>Start from words or from a photo. Either way you approve a portrait, and the sheet follows from it.</DialogDescription>
        </DialogHeader>
        {open && (
          <Tabs defaultValue="describe" className="flex flex-col gap-3">
            <TabsList aria-label="How to start">
              <TabsTrigger value="describe">From a description</TabsTrigger>
              <TabsTrigger value="photo">From a photo</TabsTrigger>
            </TabsList>
            <TabsContent value="describe">
              <Describe onCreated={onCreated} onCancel={() => onOpenChange(false)} />
            </TabsContent>
            <TabsContent value="photo">
              <FromPhoto onCreated={onCreated} onCancel={() => onOpenChange(false)} />
            </TabsContent>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  )
}

function Describe({ onCreated, onCancel }: { onCreated: Props['onCreated']; onCancel: () => void }) {
  const uid = useId()
  const create = useCreateStudioCharacter()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault()
        if (name.trim()) create.mutate({ name: name.trim(), description: description.trim() }, { onSuccess: onCreated })
      }}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${uid}-name`}>Name</Label>
        <Input id={`${uid}-name`} dir="auto" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Maya Khan" />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${uid}-desc`}>Description</Label>
        <Textarea
          id={`${uid}-desc`}
          dir="auto"
          rows={4}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Marine biologist in her 30s, sun-browned skin, black hair in a low bun, yellow raincoat over a grey wetsuit."
        />
      </div>
      {create.isError && <ErrorState compact title="Couldn't create the character" error={create.error} />}
      <DialogFooter className="mt-0">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={!name.trim()} loading={create.isPending}>
          Create character
        </Button>
      </DialogFooter>
    </form>
  )
}

function FromPhoto({ onCreated, onCancel }: { onCreated: Props['onCreated']; onCancel: () => void }) {
  const uid = useId()
  const create = useCharacterFromPhoto()
  const input = useRef<HTMLInputElement>(null)
  const [name, setName] = useState('')
  const [person, setPerson] = useState('')
  const [agreed, setAgreed] = useState(false)
  const [photo, setPhoto] = useState<MediaItem | null>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  const pick = (file: File | undefined) => {
    if (!file) return
    const why = checkFile(file, ['image'])
    if (why) return setProblem(why)
    setProblem(null)
    setProgress(0)
    uploadMedia(file, setProgress, `Character photo: ${file.name}`)
      .promise.then(setPhoto)
      .catch((e: Error) => setProblem(e.message))
      .finally(() => setProgress(null))
  }

  const ready = !!photo && !!name.trim() && !!person.trim() && agreed
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault()
        if (!ready || !photo) return
        create.mutate(
          { name: name.trim(), media_id: photo.id, consent: { name: person.trim(), statement: PHOTO_CONSENT } },
          { onSuccess: onCreated },
        )
      }}
    >
      <div className="flex items-center gap-3">
        <div className="darkroom flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-[6px]">
          {photo?.thumb_url || photo?.media_url ? (
            <img src={photo.thumb_url ?? photo.media_url ?? ''} alt="The uploaded photo" className="size-full object-cover" />
          ) : (
            <ImagePlus aria-hidden className="size-6 text-studio-on-dark-muted" />
          )}
        </div>
        <div className="flex flex-col gap-1">
          <Button type="button" variant="secondary" onClick={() => input.current?.click()} loading={progress !== null}>
            {photo ? 'Choose another photo' : 'Upload a photo'}
          </Button>
          <input ref={input} type="file" accept={acceptFor(['image'])} className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => pick(e.target.files?.[0])} />
          <span className="text-small text-studio-muted">A clear, front-facing photo works best.</span>
        </div>
      </div>
      {progress !== null && <Progress value={progress} label="Uploading the photo" />}
      {problem && <p role="alert" className="text-small text-studio-danger">{problem}</p>}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${uid}-name`}>Character name</Label>
        <Input id={`${uid}-name`} dir="auto" value={name} onChange={(e) => setName(e.target.value)} placeholder="Maya Khan" />
      </div>
      <fieldset className="flex flex-col gap-2 rounded-[6px] border border-studio-border p-3">
        <legend className="px-1 text-small font-medium">Consent</legend>
        <p className="text-small text-studio-muted">Only use photos of yourself, or of people who agreed to it.</p>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${uid}-person`}>Name of the person in the photo</Label>
          <Input id={`${uid}-person`} value={person} onChange={(e) => setPerson(e.target.value)} />
        </div>
        <label className="flex items-start gap-2 text-body">
          <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} className="mt-1 size-4 accent-studio-accent" />
          <span>{PHOTO_CONSENT}</span>
        </label>
      </fieldset>
      {create.isError && <ErrorState compact title="Couldn't create the character" error={create.error} />}
      <DialogFooter className="mt-0">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={!ready} loading={create.isPending}>
          Make a studio portrait
        </Button>
      </DialogFooter>
    </form>
  )
}
