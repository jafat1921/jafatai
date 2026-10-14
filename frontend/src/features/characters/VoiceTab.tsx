import { useId, useState } from 'react'
import { Link } from 'react-router'
import { Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { ErrorState } from '@/components/studio/states'
import { useVoiceChoices } from '@/hooks/useGallery'
import { useSaveCharacter } from '@/hooks/useCharacterStudio'
import type { Character } from '@/lib/types'
import { announce } from '@/stores/ui'
import { SELECT } from './sheet'

/** Which voice the character speaks with. Designing one from the profile and the test clip come in M12b. */
export function VoiceTab({ character }: { character: Character }) {
  const uid = useId()
  const voices = useVoiceChoices()
  const save = useSaveCharacter()
  const [voiceId, setVoiceId] = useState(character.voice_id ?? '')
  const current = voices.find((v) => v.id === voiceId)
  return (
    <form
      className="flex max-w-xl flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate({ id: character.id, voice_id: voiceId }, { onSuccess: () => announce(voiceId ? 'Voice saved.' : 'Voice cleared.') })
      }}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${uid}-voice`}>Voice</Label>
        <select id={`${uid}-voice`} className={SELECT} value={voiceId} onChange={(e) => setVoiceId(e.target.value)}>
          <option value="">No voice yet</option>
          {voices.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
              {v.id.startsWith('gallery:') ? ' · gallery' : ''}
            </option>
          ))}
        </select>
        {current?.notes && <p className="text-small text-studio-muted">{current.notes}</p>}
      </div>
      <p className="text-small text-studio-muted">
        Pick from your voices or the gallery. To clone a voice, record or upload it in{' '}
        <Link to="/audio/voices" className="underline underline-offset-2">
          Voices
        </Link>
        , then pick it here.
      </p>
      {save.isError && <ErrorState compact title="Couldn't save the voice" error={save.error} />}
      <Button type="submit" variant="primary" className="self-start" loading={save.isPending} disabled={voiceId === (character.voice_id ?? '')}>
        <Save aria-hidden />
        Save voice
      </Button>
    </form>
  )
}
