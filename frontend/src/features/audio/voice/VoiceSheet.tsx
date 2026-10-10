import { useId, useState } from 'react'
import { Link } from 'react-router'
import { Lock, Mic, Pause, Play, Star, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/alert-dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { ErrorState } from '@/components/studio/states'
import { SwitchRow } from '@/components/studio/switch-row'
import { useDeleteVoice, useUpdateVoice } from '@/hooks/useVoices'
import { clock } from '@/lib/audio'
import { GENDERS, KIND_LABEL, languageName } from '@/lib/voice'
import type { Voice, VoiceEngine, VoiceGender, VoiceLanguage, VoicePatch } from '@/lib/types'
import { announce } from '@/stores/ui'
import { togglePlay, useTrack } from '../sharedAudio'
import { SELECT } from './AddVoiceDialog'
import { TranscriptField } from './TranscriptField'
import { VoiceAvatar } from './VoiceAvatar'

// the reference plays on the shared player under its own id, apart from any Library tile
const refTrackId = (v: Pick<Voice, 'id'>) => `voice-ref-${v.id}`

export function RefPlay({ voice, className }: { voice: Voice; className?: string }) {
  const track = useTrack(refTrackId(voice))
  const url = voice.ref?.url
  if (!url) return null
  return (
    <Button
      type="button"
      size="icon-sm"
      variant="ghost"
      onClick={(e) => {
        e.stopPropagation()
        togglePlay(refTrackId(voice), url, { title: `${voice.name} (reference)`, mediaId: voice.ref?.media_id ?? null })
      }}
      aria-label={`${track.playing ? 'Pause' : 'Play'} ${voice.name}'s reference`}
      className={className}
    >
      {track.playing ? <Pause aria-hidden /> : <Play aria-hidden />}
    </Button>
  )
}

export function VoiceSheet({ voice, onClose, engines, languages }: { voice: Voice | null; onClose: () => void; engines: VoiceEngine[]; languages: VoiceLanguage[] }) {
  return (
    <Sheet open={!!voice} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-[440px] overflow-y-auto bg-studio-panel">
        {voice && <VoiceDetail key={voice.id} voice={voice} onClose={onClose} engines={engines} languages={languages} />}
      </SheetContent>
    </Sheet>
  )
}

function VoiceDetail({ voice, onClose, engines, languages }: { voice: Voice; onClose: () => void; engines: VoiceEngine[]; languages: VoiceLanguage[] }) {
  const uid = useId()
  const [draft, setDraft] = useState({ name: voice.name, language: voice.language, notes: voice.notes ?? '', gender: voice.gender_hint, refText: voice.ref_text ?? '' })
  const [confirm, setConfirm] = useState(false)
  const update = useUpdateVoice()
  const remove = useDeleteVoice()
  const patch = (p: VoicePatch, said?: string) => update.mutate({ id: voice.id, patch: p }, { onSuccess: () => said && announce(said) })

  const changes: VoicePatch = {}
  if (draft.name.trim() && draft.name.trim() !== voice.name) changes.name = draft.name.trim()
  if (draft.language !== voice.language) changes.language = draft.language
  if (draft.notes.trim() !== (voice.notes ?? '')) changes.notes = draft.notes.trim()
  if (draft.gender !== voice.gender_hint) changes.gender_hint = draft.gender
  if (draft.refText.trim() !== (voice.ref_text ?? '')) changes.ref_text = draft.refText.trim()
  const dirty = Object.keys(changes).length > 0
  // the language list may not hold the voice's own language (an engine went away)
  const options = languages.some((l) => l.code === voice.language) ? languages : [{ code: voice.language, name: languageName(voice.language, engines) }, ...languages]

  return (
    <div className="flex flex-col gap-4 p-5">
      <div className="flex items-start gap-3 pr-8">
        <VoiceAvatar voice={voice} className="size-12 text-[20px]" />
        <div className="min-w-0 flex-1">
          <SheetTitle className="truncate font-display text-title font-semibold">{voice.name}</SheetTitle>
          <SheetDescription className="text-small text-studio-muted">
            {KIND_LABEL[voice.kind]} · {languageName(voice.language, engines)} · used {voice.uses} time{voice.uses === 1 ? '' : 's'}
          </SheetDescription>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button asChild size="sm" variant="primary">
          <Link to={`/audio/speak?voice=${voice.id}`}>
            <Mic aria-hidden />
            Speak with this voice
          </Link>
        </Button>
        <Button
          type="button"
          size="sm"
          aria-pressed={voice.starred}
          onClick={() => patch({ starred: !voice.starred }, voice.starred ? `${voice.name} unstarred.` : `${voice.name} starred.`)}
        >
          <Star aria-hidden className={voice.starred ? 'fill-current text-studio-accent' : undefined} />
          {voice.starred ? 'Starred' : 'Star'}
        </Button>
        <RefPlay voice={voice} />
        {voice.ref?.duration_s ? <span className="font-mono text-small text-studio-muted">{clock(voice.ref.duration_s)}</span> : null}
      </div>

      {voice.design && (
        <section aria-label="Design recipe" className="rounded-[6px] border border-studio-border bg-studio-raised/60 p-2.5 text-small">
          <p>{voice.design.description}</p>
          <p className="mt-1 font-mono text-[11px] text-studio-faint">
            seed {voice.design.seed ?? 'random'}
            {voice.design.engine ? ` · ${engines.find((e) => e.id === voice.design!.engine)?.label ?? voice.design.engine}` : ''}
          </p>
        </section>
      )}

      <div className="flex flex-col gap-3 border-t border-studio-border pt-3">
        <div>
          <Label htmlFor={`${uid}-name`} className="mb-1.5">
            Voice name
          </Label>
          <Input id={`${uid}-name`} value={draft.name} maxLength={80} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor={`${uid}-lang`} className="mb-1.5">
              Language
            </Label>
            <select id={`${uid}-lang`} value={draft.language} onChange={(e) => setDraft({ ...draft, language: e.target.value })} className={SELECT}>
              {options.map((l) => (
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
            <select id={`${uid}-gender`} value={draft.gender ?? ''} onChange={(e) => setDraft({ ...draft, gender: (e.target.value || null) as VoiceGender | null })} className={SELECT}>
              <option value="">Not set</option>
              {GENDERS.map((g) => (
                <option key={g.value} value={g.value}>
                  {g.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div>
          <Label htmlFor={`${uid}-notes`} className="mb-1.5">
            Notes
          </Label>
          <Input id={`${uid}-notes`} value={draft.notes} maxLength={500} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} />
        </div>
        {voice.kind === 'clone' && <TranscriptField voiceId={voice.ref ? voice.id : null} value={draft.refText} onChange={(t) => setDraft((d) => ({ ...d, refText: t }))} />}
        <div className="flex justify-end">
          <Button type="button" size="sm" variant="primary" disabled={!dirty} loading={update.isPending} onClick={() => patch(changes, 'Voice saved.')}>
            Save changes
          </Button>
        </div>
        {update.error && <ErrorState compact title="Couldn't save the voice" error={update.error} />}
      </div>

      <SwitchRow
        id={`${uid}-lock`}
        checked={voice.locked}
        onChange={(on) => patch({ locked: on }, on ? `${voice.name} locked.` : `${voice.name} unlocked.`)}
        icon={<Lock aria-hidden className="size-3.5" />}
        title="Locked"
        hint="A locked voice keeps its reference clip and design; its name and notes can still change."
        className="py-2"
      />

      {voice.consent && (
        <p className="border-t border-studio-border pt-3 text-[11px] leading-4 text-studio-faint">
          Consent from {voice.consent.name}
          {voice.consent.at ? `, ${new Date(voice.consent.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}: “{voice.consent.statement}”
        </p>
      )}

      <div className="border-t border-studio-border pt-3">
        <Button type="button" size="sm" variant="ghost" onClick={() => setConfirm(true)} className="text-studio-danger hover:text-studio-danger">
          <Trash2 aria-hidden />
          Delete voice
        </Button>
        {remove.error && <ErrorState compact title="Couldn't delete the voice" error={remove.error} />}
      </div>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        tone="danger"
        title={`Delete ${voice.name}?`}
        description="The voice leaves your library. Its reference clip stays in the Library, and takes already made keep playing."
        confirmLabel="Delete voice"
        onConfirm={() =>
          remove.mutate(voice.id, {
            onSuccess: () => {
              announce(`${voice.name} deleted. The reference clip is still in the Library.`)
              onClose()
            },
          })
        }
      />
    </div>
  )
}
