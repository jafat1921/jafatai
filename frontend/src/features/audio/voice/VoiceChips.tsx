import { useDeferredValue, useId, useState } from 'react'
import { Link } from 'react-router'
import { RadioGroup } from 'radix-ui'
import { Cpu, Gauge, Hash, Languages, LibraryBig, Lock, Plus, Search, Sparkles, UserRound } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { DockChip } from '@/components/generate/DockChip'
import { useGalleryVoices } from '@/hooks/useGallery'
import { MAX_TAKES } from '@/lib/audio'
import { ENGINE_BADGE, galleryAsVoice, initialsOf, isGalleryId, matchesGallery, tintOf } from '@/lib/gallery'
import { AUTO_ENGINE, clampSpeed, speedText, engineReason, KIND_LABEL, languageName, resolveEngine, SPEED_MAX, SPEED_MIN } from '@/lib/voice'
import type { Voice, VoiceEngine, VoiceLanguage } from '@/lib/types'
import { cn } from '@/lib/utils'
import { VoiceAvatar } from './VoiceAvatar'

const ROW =
  'flex w-full items-center gap-2.5 rounded-[6px] px-2 py-1.5 text-left transition-colors duration-150 hover:bg-studio-panel-hover aria-pressed:bg-studio-accent-soft focus-visible:outline-2 focus-visible:outline-studio-accent'

// enough to scan; the full gallery has its own page
const GALLERY_SHOWN = 30

const FEATURE_TEXT: Record<string, string> = { clone: 'Clone', design: 'Design', tags: 'Tags', emotion: 'Emotion', preset_voices: 'Presets', fast: 'Fast' }

function SearchField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="relative">
      <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-studio-muted" />
      <Input type="search" aria-label={label} placeholder={label} value={value} onChange={(e) => onChange(e.target.value)} className="h-8 pl-8" />
    </div>
  )
}

export function VoiceChip({
  name = 'Voice',
  voices,
  engines,
  value,
  onChange,
  language,
}: {
  name?: string
  voices: Voice[]
  engines: VoiceEngine[]
  value: string | null
  onChange: (id: string | null) => void
  // the line's language: the Gallery section starts filtered to it
  language?: string
}) {
  const [q, setQ] = useState('')
  const query = useDeferredValue(q.trim().toLowerCase())
  const { voices: gallery } = useGalleryVoices()
  const [langPick, setLangPick] = useState<string | null>(null)
  const galleryLang = langPick ?? language ?? ''
  const mine = voices.filter((v) => !isGalleryId(v.id))
  const fromGallery = isGalleryId(value) ? gallery.find((g) => g.voice_id === value) : undefined
  const picked = mine.find((v) => v.id === value) ?? (fromGallery ? galleryAsVoice(fromGallery) : voices.find((v) => v.id === value))
  const shown = query ? mine.filter((v) => `${v.name} ${v.notes} ${languageName(v.language, engines)}`.toLowerCase().includes(query)) : mine
  // starred first, then the library's own newest-first order
  const sorted = [...shown].sort((a, b) => Number(b.starred) - Number(a.starred))
  const galleryLangs = [...new Set(gallery.flatMap((g) => g.languages))].sort((a, b) => languageName(a, engines).localeCompare(languageName(b, engines)))
  const galleryHits = gallery.filter((g) => (!galleryLang || g.languages.includes(galleryLang)) && matchesGallery(g, query, (c) => languageName(c, engines)))
  const galleryShown = galleryHits.slice(0, GALLERY_SHOWN)

  return (
    <DockChip name={name} value={picked?.name ?? 'Engine default'} icon={picked ? <VoiceAvatar voice={picked} className="size-4 text-[9px]" /> : <UserRound aria-hidden />} active={!!picked} wide>
      <SearchField label="Search voices" value={q} onChange={setQ} />
      <div className="-mx-1 flex max-h-80 flex-col gap-2 overflow-y-auto">
        <ul aria-label={`${name} choices`} className="flex flex-col gap-0.5">
          {!query && (
            <li>
              <button type="button" aria-pressed={!value} onClick={() => onChange(null)} className={ROW}>
                <VoiceAvatar voice={null} />
                <span className="min-w-0 flex-1">
                  <span className="block text-body">Engine default</span>
                  <span className="block text-[11px] text-studio-muted">The engine's own voice for the language</span>
                </span>
              </button>
            </li>
          )}
          {sorted.map((v) => (
            <li key={v.id}>
              <button type="button" aria-pressed={v.id === value} onClick={() => onChange(v.id)} className={ROW}>
                <VoiceAvatar voice={v} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body">
                    {v.name}
                    {v.starred && (
                      <>
                        <span aria-hidden className="ml-1 text-studio-accent">★</span>
                        <span className="sr-only">, starred</span>
                      </>
                    )}
                  </span>
                  <span className="block truncate text-[11px] text-studio-muted">
                    {languageName(v.language, engines)}
                    {v.uses ? ` · ${v.uses} use${v.uses === 1 ? '' : 's'}` : ''}
                  </span>
                </span>
                <span className="shrink-0 rounded-[4px] border border-studio-border px-1 text-[10px] leading-4 text-studio-muted">{KIND_LABEL[v.kind]}</span>
              </button>
            </li>
          ))}
          {sorted.length === 0 && <li className="px-2 py-3 text-small text-studio-muted">{query ? `None of your voices match “${q.trim()}”.` : 'No voices in the library yet.'}</li>}
        </ul>
        {gallery.length > 0 && (
          <section aria-label="Gallery" className="flex flex-col gap-1 border-t border-studio-border pt-2">
            <div className="flex items-center gap-2 px-1">
              <h3 className="section-label flex-1">Gallery</h3>
              <select
                aria-label="Gallery language"
                value={galleryLang}
                onChange={(e) => setLangPick(e.target.value)}
                className="h-7 rounded-[6px] border border-studio-border-strong bg-studio-raised px-1.5 text-small text-studio-text"
              >
                <option value="">All languages</option>
                {galleryLangs.map((c) => (
                  <option key={c} value={c}>
                    {languageName(c, engines)}
                  </option>
                ))}
              </select>
            </div>
            <ul aria-label={`${name} gallery choices`} className="flex flex-col gap-0.5">
              {galleryShown.map((g) => (
                <li key={g.id}>
                  <button type="button" aria-pressed={g.voice_id === value} onClick={() => onChange(g.voice_id)} className={ROW}>
                    <span aria-hidden className={cn('flex size-7 shrink-0 items-center justify-center rounded-full border border-studio-border-strong font-display text-[11px] font-semibold', tintOf(g.id))}>
                      {initialsOf(g.name)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-body">{g.name}</span>
                      <span className="block truncate text-[11px] text-studio-muted">
                        {g.accent} · {g.styles.slice(0, 2).join(', ')}
                      </span>
                    </span>
                    <span className="shrink-0 rounded-[4px] border border-studio-border px-1 text-[10px] leading-4 text-studio-muted">{ENGINE_BADGE[g.engine] ?? g.engine}</span>
                  </button>
                </li>
              ))}
              {galleryHits.length === 0 && <li className="px-2 py-2 text-small text-studio-muted">No gallery voice matches. Try all languages.</li>}
              {galleryHits.length > GALLERY_SHOWN && <li className="px-2 py-1 text-[11px] text-studio-faint">{galleryHits.length - GALLERY_SHOWN} more: type to narrow, or open the gallery.</li>}
            </ul>
          </section>
        )}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-studio-border pt-2 text-small">
        <Link to="/audio/gallery" className="inline-flex items-center gap-1 text-studio-muted hover:text-studio-text hover:underline">
          <LibraryBig aria-hidden className="size-3.5" />
          Open the gallery
        </Link>
        <Link to="/audio/design" className="inline-flex items-center gap-1 text-studio-muted hover:text-studio-text hover:underline">
          <Sparkles aria-hidden className="size-3.5" />
          Design a voice…
        </Link>
        <Link to="/audio/voices?add=1" className="inline-flex items-center gap-1 text-studio-muted hover:text-studio-text hover:underline">
          <Plus aria-hidden className="size-3.5" />
          Add a voice…
        </Link>
      </div>
    </DockChip>
  )
}

export function EngineChip({
  name = 'Engine',
  engines,
  value,
  onChange,
  language,
  voice,
  auto = true,
}: {
  name?: string
  engines: VoiceEngine[]
  value: string
  onChange: (id: string) => void
  language: string
  voice: Voice | undefined
  // offer "Auto"; Design only lists the engines that can design
  auto?: boolean
}) {
  const uid = useId()
  const resolved = resolveEngine(value, voice, language, engines)
  const label = value === AUTO_ENGINE ? `Auto${resolved ? ` · ${resolved.label}` : ''}` : (resolved?.label ?? value)
  return (
    <DockChip name={name} value={label} icon={<Cpu aria-hidden />} active={value !== AUTO_ENGINE} wide>
      <div id={`${uid}-label`} className="section-label">
        {name}
      </div>
      <RadioGroup.Root aria-labelledby={`${uid}-label`} value={value} onValueChange={onChange} className="grid gap-1.5 sm:grid-cols-2">
        {[...(auto ? [{ id: AUTO_ENGINE } as const] : []), ...engines].map((e) => {
          const isAuto = e.id === AUTO_ENGINE
          const engine = isAuto ? undefined : (e as VoiceEngine)
          const reason = engine ? engineReason(engine, language, voice, engines) : null
          const ids = `${uid}-${e.id}`
          return (
            <RadioGroup.Item
              key={e.id}
              value={e.id}
              disabled={!!reason}
              aria-label={isAuto ? 'Auto' : engine!.label}
              aria-describedby={`${ids}-d${reason ? ` ${ids}-r` : ''}`}
              className={cn(
                'flex flex-col items-stretch gap-1 rounded-[6px] border p-2 text-left transition-colors duration-150',
                'border-studio-border-strong bg-studio-raised hover:bg-studio-panel-hover',
                'data-[state=checked]:border-studio-accent data-[state=checked]:bg-studio-accent-soft',
                'disabled:cursor-not-allowed disabled:opacity-70 disabled:hover:bg-studio-raised',
              )}
            >
              <span className="flex items-center gap-2">
                <span aria-hidden className="flex size-3.5 shrink-0 items-center justify-center rounded-full border border-studio-border-strong bg-studio-panel">
                  <RadioGroup.Indicator className="size-1.5 rounded-full bg-studio-accent" />
                </span>
                <span className="min-w-0 flex-1 text-body font-medium">{isAuto ? 'Auto' : engine!.label}</span>
              </span>
              <span id={`${ids}-d`} className="flex flex-col gap-1">
                {isAuto ? (
                  <span className="text-[11px] text-studio-muted">
                    {resolved ? `${resolved.label} for this voice and language` : 'The server picks'}
                  </span>
                ) : (
                  <>
                    <span className="flex flex-wrap gap-1">
                      {engine!.features.map((f) => (
                        <span key={f} className="rounded-[4px] border border-studio-border px-1 text-[10px] leading-4 text-studio-muted">
                          {FEATURE_TEXT[f] ?? f}
                        </span>
                      ))}
                    </span>
                    <span className="text-[11px] leading-4 text-studio-faint">
                      {engine!.languages.length} language{engine!.languages.length === 1 ? '' : 's'} · {engine!.licence}
                    </span>
                  </>
                )}
              </span>
              {reason && (
                <span id={`${ids}-r`} className="flex items-start gap-1 text-[11px] leading-4 text-studio-warning">
                  <Lock aria-hidden className="mt-0.5 size-3 shrink-0" />
                  {reason}
                </span>
              )}
            </RadioGroup.Item>
          )
        })}
      </RadioGroup.Root>
    </DockChip>
  )
}

const SHOWN_MAX = 80

export function SpeechLanguageChip({ languages, engines, value, onChange }: { languages: VoiceLanguage[]; engines: VoiceEngine[]; value: string; onChange: (code: string) => void }) {
  const [q, setQ] = useState('')
  const query = useDeferredValue(q.trim().toLowerCase())
  const hits = query ? languages.filter((l) => l.name.toLowerCase().includes(query) || l.code.toLowerCase() === query) : languages
  const shown = hits.slice(0, SHOWN_MAX)
  return (
    <DockChip name="Language" value={languageName(value, engines)} icon={<Languages aria-hidden />}>
      <SearchField label="Search languages" value={q} onChange={setQ} />
      <ul aria-label="Languages" className="-mx-1 grid max-h-64 grid-cols-2 gap-0.5 overflow-y-auto">
        {shown.map((l) => (
          <li key={l.code}>
            <button type="button" aria-pressed={l.code === value} onClick={() => onChange(l.code)} className={cn(ROW, 'py-1 text-small')}>
              <span className="min-w-0 flex-1 truncate">{l.name}</span>
              <span className="shrink-0 font-mono text-[10px] text-studio-faint">{l.code}</span>
            </button>
          </li>
        ))}
      </ul>
      <p className="text-small text-studio-muted">
        {hits.length > SHOWN_MAX ? `${hits.length} languages; type to find yours.` : hits.length ? 'The languages this engine speaks.' : `No language matches “${q.trim()}”.`}
      </p>
    </DockChip>
  )
}

const SPEEDS = [0.75, 0.9, 1, 1.1, 1.25, 1.5]

export function SpeedChip({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const uid = useId()
  return (
    <DockChip name="Speed" value={speedText(value)} icon={<Gauge aria-hidden />} active={value !== 1}>
      <div>
        <label htmlFor={`${uid}-speed`} className="section-label mb-2 block">
          Speed
        </label>
        <div className="flex items-center gap-3">
          <input
            id={`${uid}-speed`}
            type="range"
            min={SPEED_MIN}
            max={SPEED_MAX}
            step={0.05}
            value={value}
            aria-valuetext={speedText(value)}
            onChange={(e) => onChange(clampSpeed(Number(e.target.value)))}
            className="h-2 min-w-0 flex-1 cursor-pointer accent-studio-accent"
          />
          <span className="w-12 shrink-0 text-right font-mono text-small">{speedText(value)}</span>
        </div>
      </div>
      <div role="group" aria-label="Speed presets" className="flex flex-wrap gap-1">
        {SPEEDS.map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={value === s}
            onClick={() => onChange(s)}
            className="h-7 rounded-[6px] border border-studio-border-strong bg-studio-raised px-2 font-mono text-small text-studio-muted hover:text-studio-text aria-pressed:border-studio-accent aria-pressed:bg-studio-accent-soft aria-pressed:text-studio-text"
          >
            {speedText(s)}
          </button>
        ))}
      </div>
      <p className="text-small text-studio-muted">From half speed to double. Very fast or slow settings can blur words.</p>
    </DockChip>
  )
}

export function SpeechTakesChip({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  const id = useId()
  return (
    <DockChip name="Count" value={`×${value}`} icon={<Hash aria-hidden />}>
      <div>
        <div id={id} className="section-label mb-2">
          Takes
        </div>
        <ToggleGroup type="single" aria-labelledby={id} value={String(value)} onValueChange={(v) => v && onChange(Number(v))}>
          {Array.from({ length: MAX_TAKES }, (_, i) => (
            <ToggleGroupItem key={i} value={String(i + 1)} aria-label={`${i + 1} take${i ? 's' : ''}`} className="w-10">
              {i + 1}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      <p className="text-small text-studio-muted">Each take uses the next seed, so the delivery varies a little.</p>
    </DockChip>
  )
}
