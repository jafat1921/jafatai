import { useId, useState } from 'react'
import { Link } from 'react-router'
import { Download } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { ErrorState } from '@/components/studio/states'
import { useExportDub } from '@/hooks/useDub'
import type { Dub, SubtitleMode } from '@/lib/dub'
import { SELECT } from '../voice/AddVoiceDialog'

const SUBS: { value: SubtitleMode; label: string; hint: string }[] = [
  { value: 'none', label: 'None', hint: '' },
  { value: 'srt', label: 'Soft', hint: 'One switchable subtitle track per language' },
  { value: 'burn', label: 'Burned in', hint: 'The default language, drawn into the picture' },
]

interface Props {
  open: boolean
  onOpenChange: (o: boolean) => void
  dub: Dub
  name: (code: string) => string
}

/** One MP4 with an audio track per language: a new version of the video in the Library. */
export function DubExportDrawer({ open, onOpenChange, dub, name }: Props) {
  const uid = useId()
  const ready = dub.targets.filter((t) => dub.tracks[t])
  const [langs, setLangs] = useState<string[]>(ready)
  const [def, setDef] = useState(ready[0] ?? '')
  const [subs, setSubs] = useState<SubtitleMode>('srt')
  const [original, setOriginal] = useState(true)
  const [stems, setStems] = useState(false)
  const run = useExportDub(dub.id)
  const chosen = langs.filter((l) => ready.includes(l))
  const dflt = chosen.includes(def) ? def : chosen[0]
  const blocked = !ready.length ? 'Mix at least one language first.' : !chosen.length ? 'Pick a language to export.' : null

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-[400px] gap-4 overflow-y-auto p-4 pt-12">
        <SheetTitle className="font-display text-title font-semibold">Export the dub</SheetTitle>
        <SheetDescription className="text-small text-studio-muted">A new version of “{dub.title}”: the picture untouched, one audio track per language.</SheetDescription>

        <fieldset className="flex flex-col gap-1.5">
          <legend className="section-label mb-1">Languages</legend>
          {dub.targets.map((t) => (
            <label key={t} className="flex items-center gap-2 text-body">
              <input
                type="checkbox"
                disabled={!dub.tracks[t]}
                checked={chosen.includes(t)}
                onChange={(e) => setLangs((l) => (e.target.checked ? [...l, t] : l.filter((x) => x !== t)))}
                className="size-4 accent-studio-accent"
              />
              {name(t)}
              {!dub.tracks[t] && <span className="text-small text-studio-muted">(not mixed yet)</span>}
            </label>
          ))}
        </fieldset>

        <label className="flex flex-col gap-1 text-small">
          <span className="section-label">Plays first</span>
          <select value={dflt ?? ''} onChange={(e) => setDef(e.target.value)} disabled={!chosen.length} className={SELECT}>
            {chosen.map((t) => (
              <option key={t} value={t}>
                {name(t)}
              </option>
            ))}
          </select>
        </label>

        <fieldset className="flex flex-col gap-1.5">
          <legend className="section-label mb-1">Subtitles</legend>
          {SUBS.map((s) => (
            <label key={s.value} className="flex items-start gap-2 text-body">
              <input type="radio" name={`${uid}-subs`} value={s.value} checked={subs === s.value} onChange={() => setSubs(s.value)} className="mt-1 size-4 accent-studio-accent" />
              <span>
                {s.label}
                {s.hint && <span className="block text-small text-studio-muted">{s.hint}</span>}
              </span>
            </label>
          ))}
        </fieldset>

        <label className="flex items-center gap-2 text-body">
          <input type="checkbox" checked={original} onChange={(e) => setOriginal(e.target.checked)} className="size-4 accent-studio-accent" />
          Keep the original sound as an extra track
        </label>
        <label className="flex items-center gap-2 text-body">
          <input type="checkbox" checked={stems} onChange={(e) => setStems(e.target.checked)} className="size-4 accent-studio-accent" />
          Stems zip (background, original voices, each dub's voices)
        </label>

        {run.error && <ErrorState compact title="Couldn't start the export" error={run.error} />}
        {run.data ? (
          <p role="status" className="text-small">
            Exporting. The new version shows up on the video in the{' '}
            <Link to="/video/library" className="underline underline-offset-2">
              Library
            </Link>{' '}
            when it's done.
          </p>
        ) : (
          <p id={`${uid}-why`} aria-live="polite" className="text-small text-studio-muted">
            {blocked ?? `${chosen.length} audio track${chosen.length === 1 ? '' : 's'}${original ? ' + the original' : ''}.`}
          </p>
        )}
        <Button
          type="button"
          variant="primary"
          disabled={!!blocked}
          loading={run.isPending}
          aria-describedby={`${uid}-why`}
          onClick={() => dflt && run.mutate({ langs: chosen, default_lang: dflt, subtitles: subs, include_original: original, stems })}
        >
          <Download aria-hidden />
          Export MP4
        </Button>
      </SheetContent>
    </Sheet>
  )
}
