import { useId, useRef, useState } from 'react'
import { Link } from 'react-router'
import { AlertTriangle, Mic, ShieldCheck, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { ErrorState } from '@/components/studio/states'
import { useUploads } from '@/hooks/useUploads'
import { useCreateVoice, useUpdateVoice } from '@/hooks/useVoices'
import { clock } from '@/lib/audio'
import { acceptFor } from '@/lib/upload'
import { cloneBlockedReason, clonePayload, CONSENT_STATEMENT, EMPTY_CLONE, GENDERS, REF_WARNING_TEXT, refProblem, refWarnings, sampleLine, type CloneForm } from '@/lib/voice'
import type { RefWarning, Voice, VoiceGender, VoiceLanguage } from '@/lib/types'
import { announce } from '@/stores/ui'
import { Recorder } from './Recorder'
import { TranscriptField } from './TranscriptField'

export const SELECT = 'h-8 w-full rounded-[6px] border border-studio-border-strong bg-studio-raised px-2 text-body'

function Warnings({ list }: { list: RefWarning[] }) {
  if (!list.length) return null
  return (
    <ul className="flex flex-col gap-1">
      {list.map((w) => (
        <li key={w} className="flex items-start gap-1.5 text-small text-studio-warning">
          <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          {REF_WARNING_TEXT[w]}
        </li>
      ))}
    </ul>
  )
}

interface Prefill extends Partial<CloneForm> {
  // shown in place of the upload row, e.g. "Speaker 1, cut from the video"
  clipLabel?: string
}

export function AddVoiceDialog({ open, onOpenChange, languages, prefill, onCreated }: {
  open: boolean
  onOpenChange: (o: boolean) => void
  languages: VoiceLanguage[]
  prefill?: Prefill
  onCreated?: (v: Voice) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        {/* a fresh form every time it opens */}
        {open && <AddVoiceForm languages={languages} prefill={prefill} onCreated={onCreated} onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  )
}

function AddVoiceForm({ languages, prefill, onCreated, onDone }: { languages: VoiceLanguage[]; prefill?: Prefill; onCreated?: (v: Voice) => void; onDone: () => void }) {
  const uid = useId()
  const [form, setForm] = useState<CloneForm>(() => ({ ...EMPTY_CLONE, ...prefill }))
  const [source, setSource] = useState<'upload' | 'record'>('upload')
  const [created, setCreated] = useState<Voice | null>(null)
  const [transcript, setTranscript] = useState('')
  const recorded = useRef<number | null>(null)
  const set = <K extends keyof CloneForm>(k: K, v: CloneForm[K]) => setForm((f) => ({ ...f, [k]: v }))
  const uploads = useUploads(['audio'], (item) => {
    const seconds = item.duration_s ?? recorded.current
    recorded.current = null
    setForm((f) => ({ ...f, refMediaId: item.id, refDurationS: seconds ?? null }))
  })
  const create = useCreateVoice()
  const update = useUpdateVoice()
  const row = uploads.rows[uploads.rows.length - 1]
  const uploading = row?.state === 'uploading'
  const blocked = uploading ? 'Wait for the clip to finish uploading.' : cloneBlockedReason(form)
  const local = refWarnings(form.refDurationS)
  const problem = refProblem(form.refDurationS)

  const addFile = (file: File, seconds: number | null) => {
    recorded.current = seconds
    setForm((f) => ({ ...f, refMediaId: null, refDurationS: null }))
    uploads.add([file])
  }

  const submit = () => {
    if (blocked || create.isPending) return
    create.mutate(clonePayload(form), {
      onSuccess: (v) => {
        setCreated(v)
        onCreated?.(v)
        setTranscript(v.ref_text || form.refText)
        announce(`${v.name} is in your voices.${v.warnings?.length ? ` ${v.warnings.map((w) => REF_WARNING_TEXT[w]).join(' ')}` : ''}`)
      },
    })
  }

  if (created) {
    const finish = () => {
      if (transcript.trim() === (created.ref_text ?? '').trim()) return onDone()
      update.mutate({ id: created.id, patch: { ref_text: transcript.trim() } }, { onSuccess: onDone })
    }
    return (
      <>
        <DialogHeader>
          <DialogTitle>{created.name} is ready</DialogTitle>
          <DialogDescription>Add what the clip says, so the clone keeps the speaker’s rhythm. You can do it later from the voice’s details.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Warnings list={created.warnings ?? []} />
          <TranscriptField voiceId={created.id} value={transcript} onChange={setTranscript} />
          {update.error && <ErrorState compact title="Couldn't save the transcript" error={update.error} />}
        </div>
        <DialogFooter className="items-center">
          <Link to={`/audio/speak?voice=${created.id}`} className="mr-auto text-small text-studio-muted underline-offset-2 hover:text-studio-text hover:underline">
            Speak with this voice
          </Link>
          <Button type="button" variant="primary" loading={update.isPending} onClick={finish}>
            Done
          </Button>
        </DialogFooter>
      </>
    )
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
      className="contents"
    >
      <DialogHeader>
        <DialogTitle>Add a voice</DialogTitle>
        <DialogDescription>Clone a voice from a short, clean clip of one person speaking.</DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Label htmlFor={`${uid}-name`} className="mb-1.5">
              Voice name
            </Label>
            <Input id={`${uid}-name`} value={form.name} maxLength={80} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Nani, warm and slow" />
          </div>
          <div>
            <Label htmlFor={`${uid}-lang`} className="mb-1.5">
              Language
            </Label>
            <select id={`${uid}-lang`} value={form.language} onChange={(e) => set('language', e.target.value)} className={SELECT}>
              {languages.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor={`${uid}-gender`} className="mb-1.5">
              Gender hint
            </Label>
            <select id={`${uid}-gender`} value={form.gender ?? ''} onChange={(e) => set('gender', (e.target.value || null) as VoiceGender | null)} className={SELECT}>
              <option value="">Not set</option>
              {GENDERS.map((g) => (
                <option key={g.value} value={g.value}>
                  {g.label}
                </option>
              ))}
            </select>
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor={`${uid}-notes`} className="mb-1.5">
              Notes
            </Label>
            <Input id={`${uid}-notes`} value={form.notes} maxLength={500} onChange={(e) => set('notes', e.target.value)} placeholder="Who it is, where it was recorded" />
          </div>
        </div>

        <fieldset className="flex flex-col gap-2.5 border-t border-studio-border pt-3">
          <legend className="section-label float-left mb-1 w-full">Reference clip</legend>
          <ToggleGroup type="single" aria-label="Reference source" value={source} onValueChange={(v) => v && setSource(v as 'upload' | 'record')} className="self-start">
            <ToggleGroupItem value="upload" className="gap-1.5 px-3 text-small">
              <Upload aria-hidden className="size-3.5" />
              Upload
            </ToggleGroupItem>
            <ToggleGroupItem value="record" className="gap-1.5 px-3 text-small">
              <Mic aria-hidden className="size-3.5" />
              Record
            </ToggleGroupItem>
          </ToggleGroup>
          {source === 'upload' ? (
            <div>
              <Label htmlFor={`${uid}-file`} className="mb-1.5">
                Audio file
              </Label>
              <input
                id={`${uid}-file`}
                type="file"
                accept={acceptFor(['audio'])}
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) addFile(f, null)
                  e.target.value = ''
                }}
                aria-describedby={`${uid}-file-hint`}
                className="block w-full text-small file:mr-3 file:h-8 file:rounded-[6px] file:border file:border-studio-border-strong file:bg-studio-raised file:px-3 file:text-body"
              />
              <p id={`${uid}-file-hint`} className="mt-1 text-small text-studio-muted">
                3 to 30 seconds of one speaker; 5 to 15 seconds without music works best. WAV, MP3, M4A, OGG or FLAC.
              </p>
            </div>
          ) : (
            <Recorder prompt={sampleLine(form.language) || undefined} onRecorded={(file, seconds) => addFile(file, seconds)} disabled={uploading} />
          )}
          {!row && prefill?.clipLabel && form.refMediaId === prefill.refMediaId && (
            <div className="flex flex-col gap-1 rounded-[6px] border border-studio-border bg-studio-raised/60 px-2.5 py-2">
              <p className="flex items-center gap-2 text-small">
                <span className="min-w-0 flex-1 truncate">{prefill.clipLabel}</span>
                {form.refDurationS != null && <span className="font-mono text-studio-muted">{clock(form.refDurationS)}</span>}
              </p>
              {problem ? <p className="text-small text-studio-danger">{problem}</p> : <Warnings list={local} />}
            </div>
          )}
          {row && (
            <div className="flex flex-col gap-1 rounded-[6px] border border-studio-border bg-studio-raised/60 px-2.5 py-2">
              <p className="flex items-center gap-2 text-small">
                <span className="min-w-0 flex-1 truncate">{row.name}</span>
                {row.state === 'done' && form.refDurationS != null && <span className="font-mono text-studio-muted">{clock(form.refDurationS)}</span>}
              </p>
              {row.state === 'uploading' && <Progress value={row.progress} label={`Uploading ${row.name}`} />}
              {row.state === 'error' && (
                <p role="alert" className="text-small text-studio-danger">
                  {row.error}
                </p>
              )}
              {row.state === 'done' && (problem ? <p className="text-small text-studio-danger">{problem}</p> : <Warnings list={local} />)}
            </div>
          )}
          <TranscriptField voiceId={null} value={form.refText} onChange={(v) => set('refText', v)} />
        </fieldset>

        <fieldset className="flex flex-col gap-2 rounded-[6px] border border-studio-border-strong bg-studio-raised/60 p-3">
          <legend className="float-left mb-1 flex w-full items-center gap-1.5 text-body font-medium">
            <ShieldCheck aria-hidden className="size-4 text-studio-accent" />
            Consent
          </legend>
          <p className="text-small text-studio-muted">Cloning needs the speaker’s agreement. The name, the statement and today’s date are kept with the voice.</p>
          <div>
            <Label htmlFor={`${uid}-who`} className="mb-1.5">
              Speaker’s name
            </Label>
            <Input id={`${uid}-who`} value={form.consentName} maxLength={120} onChange={(e) => set('consentName', e.target.value)} placeholder="The person whose voice this is" />
          </div>
          <label className="flex items-start gap-2 text-body">
            <input type="checkbox" checked={form.consented} onChange={(e) => set('consented', e.target.checked)} className="mt-1 size-4 accent-studio-accent" />
            <span>{CONSENT_STATEMENT}</span>
          </label>
        </fieldset>
        {create.error && <ErrorState compact title="Couldn't add the voice" error={create.error} />}
      </div>
      <DialogFooter className="flex-wrap items-center">
        <p id={`${uid}-why`} aria-live="polite" className="mr-auto min-w-0 text-small text-studio-muted">
          {blocked ?? 'Ready to clone.'}
        </p>
        <Button type="submit" variant="primary" disabled={!!blocked} loading={create.isPending} aria-describedby={blocked ? `${uid}-why` : undefined}>
          Create voice
        </Button>
      </DialogFooter>
    </form>
  )
}
