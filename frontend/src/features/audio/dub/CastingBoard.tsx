import { useState } from 'react'
import { Pause, Play, UserPlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { Dub, DubSpeaker } from '@/lib/dub'
import type { Voice, VoiceLanguage } from '@/lib/types'
import { refProblem } from '@/lib/voice'
import { AddVoiceDialog, SELECT } from '../voice/AddVoiceDialog'
import { togglePlay, useTrack } from '../sharedAudio'

interface Props {
  dub: Dub
  voices: Voice[]
  languages: VoiceLanguage[]
  colorOf: (speakerId: string | null) => string
  disabled: boolean
  onCast: (speakers: { id: string; label?: string; voice_id?: string | null }[]) => void
}

function SamplePlay({ spk }: { spk: DubSpeaker }) {
  const id = `dub-sample:${spk.id}:${spk.sample_media_id}`
  const { playing } = useTrack(id)
  if (!spk.sample_url) return <span className="text-[11px] text-studio-muted">No sample</span>
  return (
    <Button type="button" size="sm" variant="ghost" onClick={() => togglePlay(id, spk.sample_url!, { title: `${spk.label} · voice sample`, mediaId: spk.sample_media_id })}>
      {playing ? <Pause aria-hidden /> : <Play aria-hidden />}
      {playing ? 'Pause' : 'Hear'} {spk.label}
    </Button>
  )
}

/**
 * Who speaks with which voice. Voices cloned from the video's own speakers come first in the list;
 * "Clone this speaker" opens the usual clone form with the sample clip in it (consent still asked).
 */
export function CastingBoard({ dub, voices, languages, colorOf, disabled, onCast }: Props) {
  const [cloning, setCloning] = useState<DubSpeaker | null>(null)
  const [labels, setLabels] = useState<Record<string, string>>({})
  const samples = new Set(dub.speakers.map((s) => s.sample_media_id).filter(Boolean))
  const own = voices.filter((v) => v.ref && samples.has(v.ref.media_id))
  const rest = voices.filter((v) => !own.includes(v))
  const lines = (id: string) => dub.segments.filter((s) => s.speaker_id === id).length

  if (!dub.speakers.length) {
    return <p className="text-small text-studio-muted">The speakers appear here once the transcript is done.</p>
  }
  return (
    <>
      <ul aria-label="Speakers" className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {dub.speakers.map((spk) => {
          const label = labels[spk.id] ?? spk.label
          const short = refProblem(spk.sample_duration_s)
          return (
            <li key={spk.id} className="flex flex-col gap-2 rounded-[6px] border border-studio-border bg-studio-panel p-3">
              <div className="flex items-center gap-2">
                <span aria-hidden className="size-3 shrink-0 rounded-full" style={{ background: colorOf(spk.id) }} />
                <Input
                  aria-label={`Name of ${spk.label}`}
                  value={label}
                  maxLength={80}
                  disabled={disabled}
                  onChange={(e) => setLabels((l) => ({ ...l, [spk.id]: e.target.value }))}
                  onBlur={() => label.trim() && label.trim() !== spk.label && onCast([{ id: spk.id, label: label.trim() }])}
                  className="h-7"
                />
                <span className="shrink-0 text-[11px] text-studio-muted">
                  {lines(spk.id)} line{lines(spk.id) === 1 ? '' : 's'}
                </span>
              </div>
              <SamplePlay spk={spk} />
              <label className="flex flex-col gap-1 text-small">
                <span className="section-label">Voice</span>
                <select value={spk.voice_id ?? ''} disabled={disabled} onChange={(e) => onCast([{ id: spk.id, voice_id: e.target.value || null }])} className={SELECT}>
                  <option value="">Stand-in voice (a steady designed one)</option>
                  {own.length > 0 && (
                    <optgroup label="Cloned from this video">
                      {own.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.name}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  <optgroup label="Your voices">
                    {rest.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name}
                      </option>
                    ))}
                  </optgroup>
                </select>
              </label>
              <Button type="button" size="sm" disabled={disabled || !spk.sample_media_id || !!short} title={short ?? undefined} onClick={() => setCloning(spk)}>
                <UserPlus aria-hidden />
                Clone this speaker
              </Button>
              {short && <p className="text-[11px] text-studio-muted">{short}</p>}
            </li>
          )
        })}
      </ul>
      <AddVoiceDialog
        open={!!cloning}
        onOpenChange={(o) => !o && setCloning(null)}
        languages={languages}
        prefill={
          cloning
            ? {
                name: `${dub.title} · ${cloning.label}`.slice(0, 80),
                language: dub.source_language ?? 'en',
                refMediaId: cloning.sample_media_id ?? null,
                refDurationS: cloning.sample_duration_s ?? null,
                clipLabel: `${cloning.label}, cut from the video`,
              }
            : undefined
        }
        onCreated={(v) => cloning && onCast([{ id: cloning.id, voice_id: v.id }])}
      />
    </>
  )
}
