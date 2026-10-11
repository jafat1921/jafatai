import { useId, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { Film, Languages, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { EmptyState, ErrorState } from '@/components/studio/states'
import { MediaPicker } from '@/components/media/MediaPicker'
import { AerabOnNote } from '@/components/text/AerabButton'
import { useCreateDub, useDubs } from '@/hooks/useDub'
import { useVoiceEngines } from '@/hooks/useVoices'
import { isArabicScriptLang } from '@/lib/aerab'
import { allDone, checkpoint, currentStage, dubBusy, failure, STAGE_LABEL, SUGGESTED_TARGETS, type DubQuality, type DubSummary } from '@/lib/dub'
import type { MediaItem } from '@/lib/types'
import { allLanguages, languageName } from '@/lib/voice'
import { cn } from '@/lib/utils'
import { SELECT } from '../voice/AddVoiceDialog'

const MAX_TARGETS = 8

export function DubListPage() {
  const list = useDubs()
  const dubs = list.data ?? []
  const { engines } = useVoiceEngines()
  const name = (code: string) => languageName(code, engines)

  return (
    <main data-f6-region tabIndex={-1} aria-labelledby="dub-title" className="h-full overflow-y-auto focus-visible:outline-none">
      <div className="mx-auto flex max-w-5xl flex-col gap-4 px-4 py-6 md:px-8">
        <header>
          <h1 id="dub-title" className="font-display text-title font-semibold">
            Dub a video
          </h1>
          <p className="text-small text-studio-muted">
            Separate the voices from the background, transcribe, translate, re-voice every line in its slot and mix it back. You check the transcript and the translation before anything is voiced.
          </p>
        </header>

        <NewDub name={name} languages={allLanguages(engines.map((e) => e.languages))} />

        {list.isPending ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-14" />
            ))}
          </div>
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => list.refetch()} />
        ) : dubs.length === 0 ? (
          <EmptyState icon={<Languages />} title="No dubs yet">
            Pick a video above. Short clips with clear dialogue are the quickest to start with.
          </EmptyState>
        ) : (
          <ul aria-label="Dubs" className="divide-y divide-studio-border rounded-[6px] border border-studio-border bg-studio-panel">
            {dubs.map((d) => (
              <DubRow key={d.id} dub={d} name={name} />
            ))}
          </ul>
        )}
      </div>
    </main>
  )
}

function stateOf(d: DubSummary): { text: string; tone: string } {
  const f = failure(d)
  if (f) return { text: `${STAGE_LABEL[f.stage]} failed`, tone: 'border-studio-danger text-studio-danger' }
  if (checkpoint(d)) return { text: 'Waiting for you', tone: 'border-studio-warning text-studio-warning' }
  if (dubBusy(d)) return { text: `${STAGE_LABEL[currentStage(d)]}…`, tone: 'border-studio-accent text-studio-accent' }
  if (allDone(d)) return { text: 'Dubbed', tone: 'border-studio-success text-studio-success' }
  return { text: `Stopped at ${STAGE_LABEL[currentStage(d)]}`, tone: 'border-studio-border text-studio-muted' }
}

function DubRow({ dub, name }: { dub: DubSummary; name: (c: string) => string }) {
  const s = stateOf(dub)
  return (
    <li className="flex items-center gap-3 px-3 py-2.5">
      <Film aria-hidden className="size-4 shrink-0 text-studio-muted" />
      <div className="min-w-0 flex-1">
        <Link to={`/audio/dub/${dub.id}`} className="block truncate text-body font-medium hover:underline">
          {dub.title}
        </Link>
        <p className="text-[11px] text-studio-muted">
          {dub.source_language ? name(dub.source_language) : 'Detecting'} → {dub.targets.map(name).join(', ')} · {dub.segment_count} line{dub.segment_count === 1 ? '' : 's'}
          {dub.speaker_count ? ` · ${dub.speaker_count} speaker${dub.speaker_count === 1 ? '' : 's'}` : ''}
        </p>
      </div>
      <span className={cn('shrink-0 rounded-[4px] border px-1.5 text-[11px] leading-5', s.tone)}>{s.text}</span>
    </li>
  )
}

function NewDub({ name, languages }: { name: (c: string) => string; languages: { code: string; name: string }[] }) {
  const uid = useId()
  const navigate = useNavigate()
  const create = useCreateDub()
  const [picking, setPicking] = useState(false)
  const [video, setVideo] = useState<MediaItem | null>(null)
  const [targets, setTargets] = useState<string[]>(['ur'])
  const [more, setMore] = useState('')
  const [fixed, setFixed] = useState(false)
  // a draft string, so clearing the box to type another number doesn't snap it back
  const [count, setCount] = useState('2')
  const speakers: 'auto' | number = fixed ? Math.max(1, Math.min(12, Math.round(Number(count)) || 1)) : 'auto'
  const [quality, setQuality] = useState<DubQuality>('fast')
  const [source, setSource] = useState('auto')

  const toggle = (code: string) =>
    setTargets((t) => (t.includes(code) ? t.filter((x) => x !== code) : t.length < MAX_TARGETS ? [...t, code] : t))
  const blocked = !video ? 'Pick the video to dub.' : !targets.length ? 'Pick at least one language to dub into.' : null
  const chips = [...new Set([...SUGGESTED_TARGETS, ...targets])]

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (blocked || !video) return
    create.mutate(
      { video_id: video.id, targets, speakers, settings: { quality }, ...(source !== 'auto' ? { source_language: source } : {}) },
      { onSuccess: (d) => navigate(`/audio/dub/${d.id}`) },
    )
  }

  return (
    <form onSubmit={submit} aria-label="New dub" className="flex flex-col gap-3 rounded-[6px] border border-studio-border-strong bg-studio-panel p-3 shadow-card">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" onClick={() => setPicking(true)}>
          <Film aria-hidden />
          {video ? 'Change video' : 'Pick a video'}
        </Button>
        {video && (
          <span className="flex min-w-0 items-center gap-2 text-small">
            {video.thumb_url && <img src={video.thumb_url} alt="" className="h-8 w-14 rounded-[4px] object-cover" />}
            <span className="truncate font-medium">{video.title || 'Untitled video'}</span>
            <button type="button" onClick={() => setVideo(null)} aria-label="Clear the video" className="rounded-[4px] p-1 text-studio-muted hover:bg-studio-panel-hover hover:text-studio-text">
              <X aria-hidden className="size-3.5" />
            </button>
          </span>
        )}
      </div>

      <fieldset className="flex flex-col gap-1.5">
        <legend className="section-label mb-1">Dub into</legend>
        <div className="flex flex-wrap items-center gap-1.5">
          {chips.map((code) => (
            <button
              key={code}
              type="button"
              aria-pressed={targets.includes(code)}
              onClick={() => toggle(code)}
              className={cn(
                'h-7 rounded-full border px-2.5 text-small',
                targets.includes(code) ? 'border-studio-accent bg-studio-accent text-studio-accent-fg' : 'border-studio-border-strong bg-studio-raised hover:bg-studio-panel-hover',
              )}
            >
              {name(code)}
            </button>
          ))}
          <label className="sr-only" htmlFor={`${uid}-more`}>
            Another language
          </label>
          <select
            id={`${uid}-more`}
            value={more}
            onChange={(e) => {
              if (e.target.value) toggle(e.target.value)
              setMore('')
            }}
            className={cn(SELECT, 'h-7 w-40')}
          >
            <option value="">More languages…</option>
            {languages
              .filter((l) => !chips.includes(l.code))
              .map((l) => (
                <option key={l.code} value={l.code}>
                  {l.name}
                </option>
              ))}
          </select>
        </div>
        {targets.some(isArabicScriptLang) && <AerabOnNote language={targets.find(isArabicScriptLang)} />}
      </fieldset>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex w-44 flex-col gap-1 text-small">
          <span className="section-label">Spoken now in</span>
          <select value={source} onChange={(e) => setSource(e.target.value)} className={SELECT}>
            <option value="auto">Detect it</option>
            {languages.map((l) => (
              <option key={l.code} value={l.code}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        <div className="flex flex-col gap-1 text-small">
          <span className="section-label" id={`${uid}-spk`}>
            Speakers
          </span>
          <div className="flex items-center gap-1.5">
            <ToggleGroup type="single" aria-labelledby={`${uid}-spk`} value={fixed ? 'n' : 'auto'} onValueChange={(v) => v && setFixed(v === 'n')}>
              <ToggleGroupItem value="auto" className="px-3 text-small">
                Auto
              </ToggleGroupItem>
              <ToggleGroupItem value="n" className="px-3 text-small">
                Fixed
              </ToggleGroupItem>
            </ToggleGroup>
            {fixed && (
              <Input
                type="number"
                aria-label="Number of speakers"
                min={1}
                max={12}
                value={count}
                onChange={(e) => setCount(e.target.value)}
                onBlur={() => setCount(String(speakers))}
                className="h-8 w-16"
              />
            )}
          </div>
        </div>
        <div className="flex flex-col gap-1 text-small">
          <span className="section-label" id={`${uid}-q`}>
            Translation
          </span>
          <ToggleGroup type="single" aria-labelledby={`${uid}-q`} value={quality} onValueChange={(v) => v && setQuality(v as DubQuality)}>
            <ToggleGroupItem value="fast" className="px-3 text-small">
              Fast
            </ToggleGroupItem>
            <ToggleGroupItem value="careful" className="px-3 text-small" title="Translate, then a second pass reviews every line">
              Careful
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
        <div className="ml-auto flex flex-col items-end gap-1">
          <p id={`${uid}-why`} aria-live="polite" className="text-small text-studio-muted">
            {blocked ?? `${targets.length} language${targets.length === 1 ? '' : 's'}`}
          </p>
          <Button type="submit" variant="primary" disabled={!!blocked} loading={create.isPending} aria-describedby={`${uid}-why`}>
            <Plus aria-hidden />
            New dub
          </Button>
        </div>
      </div>
      {create.isError && (
        <p role="alert" className="text-small text-studio-danger">
          {create.error.message}
        </p>
      )}
      <MediaPicker
        open={picking}
        onOpenChange={setPicking}
        kind="video"
        max={1}
        title="Pick a video to dub"
        confirmLabel="Dub this"
        onConfirm={([m]) => m && setVideo(m)}
      />
    </form>
  )
}
