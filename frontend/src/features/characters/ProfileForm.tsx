import { useEffect, useId, useRef, useState } from 'react'
import { Loader2, Save, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { ErrorState } from '@/components/studio/states'
import { AerabButton } from '@/components/text/AerabButton'
import { useAiJob } from '@/hooks/useAi'
import { useSaveCharacter } from '@/hooks/useCharacterStudio'
import { api } from '@/lib/api'
import { PROFILE_FIELDS, type Character, type CharacterProfile, type ProfileField } from '@/lib/types'
import { announce } from '@/stores/ui'

const LABELS: Record<ProfileField, { label: string; hint: string }> = {
  role: { label: 'Role', hint: 'Marine biologist, getaway driver…' },
  affiliation: { label: 'Affiliation', hint: 'Team, family or side' },
  nationality: { label: 'Nationality', hint: 'Pakistani' },
  height: { label: 'Height', hint: '172 cm' },
  age: { label: 'Age', hint: '34' },
  gender: { label: 'Gender', hint: 'Woman' },
  languages: { label: 'Languages', hint: 'Urdu, English' },
  personality: { label: 'Personality', hint: 'Curious, stubborn, kind' },
  accent: { label: 'Accent', hint: 'Soft Lahori' },
  wardrobe: { label: 'Wardrobe', hint: 'Yellow raincoat over a grey wetsuit' },
}
// the long ones get a full row
const WIDE = new Set<ProfileField>(['personality', 'wardrobe'])

/** Name, description and the identity block the sheet prints. "Fill from description" only fills empty fields. */
export function ProfileForm({ character }: { character: Character }) {
  const uid = useId()
  const save = useSaveCharacter()
  const [name, setName] = useState(character.name)
  const [description, setDescription] = useState(character.description)
  const [profile, setProfile] = useState<CharacterProfile>(character.profile ?? {})
  const [dirty, setDirty] = useState(false)

  // a server change (the AI fill, another tab) shows up unless the user is mid-edit
  const [seen, setSeen] = useState(character)
  if (seen !== character) {
    setSeen(character)
    if (!dirty) {
      setName(character.name)
      setDescription(character.description)
      setProfile(character.profile ?? {})
    }
  }

  const filler = useAiJob(() => api.characters.aiProfile(character.id))
  const applied = useRef<string | null>(null)
  const done = filler.job?.status === 'done' ? filler.job : undefined
  useEffect(() => {
    if (done && applied.current !== done.id) {
      applied.current = done.id
      const got = (done.result?.profile ?? {}) as CharacterProfile
      setProfile((p) => ({ ...got, ...Object.fromEntries(Object.entries(p).filter(([, v]) => v)) }))
      const n = (done.result?.filled as string[] | undefined)?.length ?? 0
      announce(n ? `Filled ${n} profile fields from the description. Review them, then Save.` : 'Nothing to fill: every field already has a value.')
      setDirty(true)
    }
  }, [done])

  const set = (k: ProfileField, v: string) => {
    setProfile((p) => ({ ...p, [k]: v }))
    setDirty(true)
  }

  const submit = () => {
    if (!name.trim()) return
    // send every field, blanks included, so a cleared field is cleared on the server too
    const body = Object.fromEntries(PROFILE_FIELDS.map((k) => [k, profile[k] ?? ''])) as CharacterProfile
    save.mutate(
      { id: character.id, name: name.trim(), description, profile: body },
      {
        onSuccess: () => {
          setDirty(false)
          announce('Profile saved.')
        },
      },
    )
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${uid}-name`}>Name</Label>
          <Input id={`${uid}-name`} dir="auto" value={name} onChange={(e) => (setName(e.target.value), setDirty(true))} />
          <AerabButton text={name} onText={(t) => (setName(t), setDirty(true))} target="the name" showNote={false} />
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${uid}-desc`}>Description</Label>
        <Textarea
          id={`${uid}-desc`}
          dir="auto"
          rows={3}
          value={description}
          onChange={(e) => (setDescription(e.target.value), setDirty(true))}
          placeholder="How they look: age, build, face, hair, signature outfit with colours."
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <h3 className="section-label flex-1">Profile</h3>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() => filler.run(undefined)}
          disabled={filler.working || !description.trim()}
          aria-describedby={`${uid}-fill`}
        >
          {filler.working ? <Loader2 aria-hidden className="animate-spin" /> : <Sparkles aria-hidden />}
          Fill from description
        </Button>
      </div>
      <p id={`${uid}-fill`} role="status" className="-mt-2 text-small text-studio-muted">
        {filler.working
          ? filler.job?.status === 'running'
            ? filler.job.message
            : 'Waiting for a worker…'
          : 'Fills only the empty fields and suggests props and accessories for the sheet. Save the description first.'}
      </p>
      {filler.error && <ErrorState compact title="The AI couldn't fill the profile" error={filler.error} />}

      <div className="grid gap-3 sm:grid-cols-2">
        {PROFILE_FIELDS.map((k) => (
          <div key={k} className={WIDE.has(k) ? 'flex flex-col gap-1.5 sm:col-span-2' : 'flex flex-col gap-1.5'}>
            <Label htmlFor={`${uid}-${k}`}>{LABELS[k].label}</Label>
            <Input
              id={`${uid}-${k}`}
              dir="auto"
              maxLength={300}
              value={profile[k] ?? ''}
              placeholder={LABELS[k].hint}
              onChange={(e) => set(k, e.target.value)}
            />
            <AerabButton text={profile[k] ?? ''} onText={(t) => set(k, t)} target={LABELS[k].label.toLowerCase()} showNote={false} />
          </div>
        ))}
      </div>

      {save.isError && <ErrorState compact title="Couldn't save the profile" error={save.error} />}
      <div className="flex items-center gap-3">
        <Button type="submit" variant="primary" loading={save.isPending} disabled={!dirty || !name.trim()}>
          <Save aria-hidden />
          Save profile
        </Button>
        {dirty && <span className="text-small text-studio-muted">Unsaved changes</span>}
      </div>
    </form>
  )
}
