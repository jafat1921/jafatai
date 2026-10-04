import { ChipGroup } from '@/components/studio/chip'
import { useUpdateScene } from '@/hooks/useScenes'
import { LocationPicker } from './LocationPicker'
import type { Scene, ScenePatch, TimeOfDay } from '@/lib/types'
import { useProjectId } from './selection'

const TIME_OF_DAY: { value: TimeOfDay; label: string }[] = [
  { value: 'dawn', label: 'Dawn' },
  { value: 'morning', label: 'Morning' },
  { value: 'day', label: 'Day' },
  { value: 'golden_hour', label: 'Golden hour' },
  { value: 'dusk', label: 'Dusk' },
  { value: 'night', label: 'Night' },
  { value: 'interior', label: 'Interior' },
]

// Contract leaves mood/lighting as free strings; these are our curated defaults.
const MOOD = ['neutral', 'tense', 'joyful', 'melancholic', 'mysterious', 'action', 'romantic', 'horror'].map((v) => ({
  value: v,
  label: v[0].toUpperCase() + v.slice(1),
}))

const LIGHTING = [
  ['natural', 'Natural'],
  ['low_key', 'Low-key'],
  ['high_key', 'High-key'],
  ['rembrandt', 'Rembrandt'],
  ['backlit', 'Backlit'],
  ['practical', 'Practical'],
  ['chiaroscuro', 'Chiaroscuro'],
  ['blue_hour', 'Blue hour'],
  ['neon', 'Neon'],
  ['moonlight', 'Moonlight'],
].map(([value, label]) => ({ value, label }))

export function SceneMetaChips({ scene }: { scene: Scene }) {
  const update = useUpdateScene(useProjectId())
  const set = (patch: ScenePatch) => update.mutate({ id: scene.id, patch })

  return (
    <div className="mt-1.5 flex flex-col gap-3 rounded-[6px] border border-studio-border bg-studio-bg/40 p-2.5">
      <LocationPicker
        id={`scene-location-${scene.id}`}
        value={scene.location_id ?? null}
        onChange={(v) => set({ location_id: v })}
      />
      <ChipGroup label="Time of day" options={TIME_OF_DAY} value={scene.time_of_day} onChange={(v) => set({ time_of_day: v })} />
      <ChipGroup label="Mood" options={MOOD} value={scene.mood} onChange={(v) => set({ mood: v })} />
      <ChipGroup label="Lighting" options={LIGHTING} value={scene.lighting} onChange={(v) => set({ lighting: v })} />
      {update.isError && (
        <p role="alert" className="text-small text-studio-danger">
          Couldn&apos;t save: {update.error.message}
        </p>
      )}
    </div>
  )
}
