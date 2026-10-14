import { useId, useRef, useState } from 'react'
import { Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { acceptFor, checkFile, uploadMedia } from '@/lib/upload'
import type { MediaItem, PhotoConsentRecord } from '@/lib/types'
import { PHOTO_CONSENT } from './sheet'

/** Whose photo it is and the statement; "From a photo" and every own-image upload ask the same way. */
export function PhotoConsentFields({
  person,
  agreed,
  onPerson,
  onAgreed,
}: {
  person: string
  agreed: boolean
  onPerson: (v: string) => void
  onAgreed: (v: boolean) => void
}) {
  const uid = useId()
  return (
    <fieldset className="flex flex-col gap-2 rounded-[6px] border border-studio-border p-3">
      <legend className="px-1 text-small font-medium">Consent</legend>
      <p className="text-small text-studio-muted">Only use photos of yourself, or of people who agreed to it.</p>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${uid}-person`}>Name of the person in the photo</Label>
        <Input id={`${uid}-person`} dir="auto" maxLength={120} value={person} onChange={(e) => onPerson(e.target.value)} />
      </div>
      <label className="flex items-start gap-2 text-body">
        <input type="checkbox" checked={agreed} onChange={(e) => onAgreed(e.target.checked)} className="mt-1 size-4 accent-studio-accent" />
        <span>{PHOTO_CONSENT}</span>
      </label>
    </fieldset>
  )
}

interface Props {
  label: string
  // Library title, before the file name
  title: string
  busy?: boolean
  hint?: string
  onUploaded: (media: MediaItem, consent?: PhotoConsentRecord) => void
}

/** Pick a picture, put it in the Library, hand it on. A photo of a real person needs consent before the picker opens. */
export function OwnImageUpload({ label, title, busy, hint, onUploaded }: Props) {
  const uid = useId()
  const input = useRef<HTMLInputElement>(null)
  const [real, setReal] = useState(false)
  const [person, setPerson] = useState('')
  const [agreed, setAgreed] = useState(false)
  const [progress, setProgress] = useState<number | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const blocked = !real ? null : !person.trim() ? 'Type the name of the person in the photo.' : !agreed ? 'Tick the consent statement first.' : null

  const pick = (file: File | undefined) => {
    if (!file) return
    const why = checkFile(file, ['image'])
    if (why) return setProblem(why)
    setProblem(null)
    setProgress(0)
    uploadMedia(file, setProgress, `${title}: ${file.name}`)
      .promise.then((m) => onUploaded(m, real ? { name: person.trim(), statement: PHOTO_CONSENT } : undefined))
      .catch((e: Error) => setProblem(e.message))
      .finally(() => setProgress(null))
  }

  return (
    <div className="flex flex-col gap-2">
      <label className="flex items-center gap-2 text-body">
        <input type="checkbox" checked={real} onChange={(e) => setReal(e.target.checked)} className="size-4 accent-studio-accent" />
        It's a photo of a real person
      </label>
      {real && <PhotoConsentFields person={person} agreed={agreed} onPerson={setPerson} onAgreed={setAgreed} />}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          aria-disabled={!!blocked || undefined}
          aria-describedby={`${uid}-why`}
          loading={progress !== null || busy}
          onClick={() => !blocked && input.current?.click()}
        >
          <Upload aria-hidden />
          {label}
        </Button>
        <input
          ref={input}
          type="file"
          accept={acceptFor(['image'])}
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          onChange={(e) => {
            pick(e.target.files?.[0])
            e.target.value = ''
          }}
        />
        <span id={`${uid}-why`} aria-live="polite" className="text-small text-studio-muted">
          {blocked ?? hint}
        </span>
      </div>
      {progress !== null && <Progress value={progress} label={`Uploading: ${label}`} />}
      {problem && (
        <p role="alert" className="text-small text-studio-danger">
          {problem}
        </p>
      )}
    </div>
  )
}
