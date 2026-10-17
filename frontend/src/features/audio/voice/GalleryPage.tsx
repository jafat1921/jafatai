import { useDeferredValue, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { Check, Library, Loader2, Mic, Pause, Play, Plus, Search, Star } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState, ErrorState } from '@/components/studio/states'
import { qk } from '@/hooks/keys'
import { useAddGalleryVoice, useGallery, useGallerySample } from '@/hooks/useGallery'
import { useUpdateVoice, useVoiceEngines } from '@/hooks/useVoices'
import { ENGINE_BADGE, FACET_LABEL, FACET_NAMES, initialsOf, tintOf, type GalleryFacetName, type GalleryFacetValue, type GalleryQuery, type GalleryVoice } from '@/lib/gallery'
import { languageName } from '@/lib/voice'
import type { VoiceEngine } from '@/lib/types'
import { cn } from '@/lib/utils'
import { announce } from '@/stores/ui'
import { useTrack } from '../sharedAudio'
import { SELECT } from './AddVoiceDialog'

// beyond this many languages the rest go in a select, or the row would be a wall of chips
const LANGUAGE_CHIPS = 8

const CHIP =
  'inline-flex h-7 items-center gap-1.5 rounded-full border border-studio-border-strong bg-studio-raised px-2.5 text-small text-studio-muted transition-colors duration-150 hover:text-studio-text aria-pressed:border-studio-accent aria-pressed:bg-studio-accent-soft aria-pressed:text-studio-text focus-visible:outline-2 focus-visible:outline-studio-accent'

type Filters = Partial<Record<GalleryFacetName, string>>

export function GalleryPage() {
  const [q, setQ] = useState('')
  const [filters, setFilters] = useState<Filters>({})
  const query: GalleryQuery = { ...filters, q: useDeferredValue(q.trim()) || undefined }
  const list = useGallery(query)
  const { engines } = useVoiceEngines()
  const items = list.data?.items ?? []
  const filtered = !!(query.q || Object.values(filters).some(Boolean))

  const pick = (name: GalleryFacetName, value: string) => setFilters((f) => ({ ...f, [name]: f[name] === value ? undefined : value || undefined }))

  return (
    <main data-f6-region tabIndex={-1} aria-labelledby="gallery-title" className="relative h-full overflow-y-auto focus-visible:outline-none">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-6 md:px-8">
        <header className="min-w-0">
          <h1 id="gallery-title" className="font-display text-title font-semibold">
            Voice gallery
          </h1>
          <p className="text-small text-studio-muted">Ready-made voices in Urdu, Hindi, Punjabi, Arabic, English and more. Hear one, use it in Speak, or keep it in your voices.</p>
        </header>

        <div role="search" aria-label="Filter the gallery" className="flex flex-col gap-2 border-b border-studio-border pb-3">
          <div className="relative max-w-md">
            <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-studio-muted" />
            <Input type="search" aria-label="Search the gallery" placeholder="Search: Lahori, news, grandmother…" value={q} onChange={(e) => setQ(e.target.value)} className="pl-8" />
          </div>
          {list.data &&
            FACET_NAMES.map((name) => <FacetRow key={name} name={name} values={list.data!.facets[name] ?? []} value={filters[name]} onPick={(v) => pick(name, v)} />)}
        </div>

        <p aria-live="polite" className="text-small text-studio-muted">
          {list.data ? `${list.data.total} voice${list.data.total === 1 ? '' : 's'}` : ' '}
          {filtered && (
            <button
              type="button"
              className="ml-3 text-studio-accent-hover underline-offset-2 hover:underline"
              onClick={() => {
                setFilters({})
                setQ('')
              }}
            >
              Clear filters
            </button>
          )}
        </p>

        {list.isPending ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-36" />
            ))}
          </div>
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => list.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState icon={<Library />} title="No voice matches">
            Try fewer filters or another word.
          </EmptyState>
        ) : (
          <VoiceGrid items={items} engines={engines} />
        )}
      </div>
    </main>
  )
}

function FacetRow({ name, values, value, onPick }: { name: GalleryFacetName; values: GalleryFacetValue[]; value: string | undefined; onPick: (v: string) => void }) {
  const many = name === 'language' && values.length > LANGUAGE_CHIPS
  let chips = many ? values.slice(0, LANGUAGE_CHIPS) : values
  const rest = many ? values.slice(LANGUAGE_CHIPS) : []
  // a picked value always shows as a chip, even when it has no voices left under the other filters
  if (value && !chips.some((c) => c.value === value)) {
    const hit = values.find((c) => c.value === value)
    chips = [...chips, hit ?? { value, label: value, count: 0 }]
  }
  return (
    <div role="group" aria-label={FACET_LABEL[name]} className="flex flex-wrap items-center gap-1.5">
      <span className="w-16 shrink-0 text-[11px] uppercase tracking-wide text-studio-faint">{FACET_LABEL[name]}</span>
      <button type="button" aria-pressed={!value} onClick={() => onPick('')} className={CHIP}>
        All
      </button>
      {chips.map((c) => (
        <button key={c.value} type="button" aria-pressed={value === c.value} aria-label={`${c.label} (${c.count})`} onClick={() => onPick(c.value)} className={CHIP}>
          {c.label}
          <span className="font-mono text-[10px] text-studio-faint">{c.count}</span>
        </button>
      ))}
      {rest.length > 0 && (
        <select aria-label="More languages" value={rest.some((r) => r.value === value) ? value : ''} onChange={(e) => e.target.value && onPick(e.target.value)} className={cn(SELECT, 'h-7 w-40 text-small')}>
          <option value="">More languages…</option>
          {rest.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label} ({r.count})
            </option>
          ))}
        </select>
      )}
    </div>
  )
}

function columnsOf(el: HTMLElement | null) {
  if (!el) return 1
  const cols = getComputedStyle(el).gridTemplateColumns
  return cols && cols !== 'none' ? cols.trim().split(/\s+/).length : 1
}

function VoiceGrid({ items, engines }: { items: GalleryVoice[]; engines: VoiceEngine[] }) {
  const navigate = useNavigate()
  const listRef = useRef<HTMLUListElement>(null)
  const [active, setActive] = useState(0)
  const { play, state } = useGallerySample()
  const at = Math.min(active, items.length - 1)

  const openInSpeak = (g: GalleryVoice) => navigate(`/audio/speak?voice=${encodeURIComponent(g.voice_id)}`)

  const focusCard = (i: number) => {
    const next = Math.max(0, Math.min(items.length - 1, i))
    setActive(next)
    listRef.current?.querySelectorAll<HTMLElement>('[data-card]')[next]?.focus()
  }

  const onKey = (e: React.KeyboardEvent, i: number) => {
    // keys typed into the card's own buttons stay theirs
    if (e.target !== e.currentTarget) return
    const cols = columnsOf(listRef.current)
    const moves: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols, Home: -i, End: items.length - 1 - i }
    if (e.key in moves) {
      e.preventDefault()
      focusCard(i + moves[e.key])
    } else if (e.key === ' ') {
      e.preventDefault()
      play(items[i])
    } else if (e.key === 'Enter') {
      e.preventDefault()
      openInSpeak(items[i])
    }
  }

  return (
    <>
      <p id="gallery-keys" className="sr-only">
        Arrow keys move between voices. Space plays the sample, Enter uses the voice in Speak.
      </p>
      <ul ref={listRef} aria-label="Gallery voices" aria-describedby="gallery-keys" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((g, i) => (
          <GalleryCard
            key={g.id}
            voice={g}
            engines={engines}
            tabIndex={i === at ? 0 : -1}
            sample={state[g.id]}
            onKeyDown={(e) => onKey(e, i)}
            onFocus={() => setActive(i)}
            onPlay={() => play(g)}
            onUse={() => openInSpeak(g)}
          />
        ))}
      </ul>
    </>
  )
}

interface CardProps {
  voice: GalleryVoice
  engines: VoiceEngine[]
  tabIndex: number
  sample: 'preparing' | 'failed' | undefined
  onKeyDown: (e: React.KeyboardEvent) => void
  onFocus: () => void
  onPlay: () => void
  onUse: () => void
}

function GalleryCard({ voice: g, engines, tabIndex, sample, onKeyDown, onFocus, onPlay, onUse }: CardProps) {
  const qc = useQueryClient()
  const track = useTrack(`gallery:${g.id}`)
  const add = useAddGalleryVoice()
  const update = useUpdateVoice()
  const langs = g.languages.map((l) => languageName(l, engines)).join(', ')
  const nameId = `gv-${g.id}`

  const keep = () =>
    add.mutate({ id: g.id }, { onSuccess: (v) => announce(`${v.name} is in your voices.`) })
  const star = () => {
    if (g.added_voice_id && g.starred) {
      update.mutate(
        { id: g.added_voice_id, patch: { starred: false } },
        {
          onSuccess: (v) => {
            qc.invalidateQueries({ queryKey: qk.galleryAll })
            announce(`${v.name} unstarred.`)
          },
        },
      )
    } else {
      add.mutate({ id: g.id, starred: true }, { onSuccess: (v) => announce(`${v.name} starred and kept in your voices.`) })
    }
  }

  return (
    <li className="list-none">
      <div
        data-card
        tabIndex={tabIndex}
        aria-labelledby={nameId}
        aria-describedby={`${nameId}-d`}
        onKeyDown={onKeyDown}
        onFocus={(e) => e.target === e.currentTarget && onFocus()}
        className="flex h-full flex-col gap-3 rounded-[6px] border border-studio-border-strong bg-studio-panel p-3 shadow-card focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-studio-accent"
      >
        <div className="flex items-start gap-3">
          <span aria-hidden className={cn('flex size-11 shrink-0 items-center justify-center rounded-full border border-studio-border-strong font-display text-[15px] font-semibold', tintOf(g.id))}>
            {initialsOf(g.name)}
          </span>
          <div className="min-w-0 flex-1">
            <h2 id={nameId} className="truncate text-body font-medium">
              {g.name}
            </h2>
            <p id={`${nameId}-d`} className="truncate text-[11px] text-studio-muted">
              {g.accent} · {langs}
            </p>
          </div>
          <span className="shrink-0 rounded-[4px] border border-studio-border px-1 text-[10px] leading-4 text-studio-muted">{ENGINE_BADGE[g.engine] ?? g.engine}</span>
        </div>
        <ul aria-label="Tags" className="flex flex-wrap gap-1">
          {[g.gender, g.age, ...g.styles].map((t) => (
            <li key={t} className="rounded-[4px] bg-studio-raised px-1.5 text-[11px] leading-5 text-studio-muted">
              {t}
            </li>
          ))}
        </ul>
        <div className="mt-auto flex flex-wrap items-center gap-1.5">
          <Button type="button" size="sm" variant="secondary" tabIndex={tabIndex} onClick={onPlay} disabled={sample === 'preparing'} aria-label={`${track.playing ? 'Pause' : 'Play'} the sample of ${g.name}`}>
            {sample === 'preparing' ? <Loader2 aria-hidden className="animate-spin" /> : track.playing ? <Pause aria-hidden /> : <Play aria-hidden />}
            {sample === 'preparing' ? 'Preparing sample…' : sample === 'failed' ? 'Try again' : track.playing ? 'Pause' : 'Play'}
          </Button>
          <Button type="button" size="sm" variant="primary" tabIndex={tabIndex} onClick={onUse} aria-label={`Use ${g.name} in Speak`}>
            <Mic aria-hidden />
            Use in Speak
          </Button>
          {g.added_voice_id ? (
            <span className="inline-flex h-7 items-center gap-1 px-1 text-small text-studio-muted">
              <Check aria-hidden className="size-3.5" />
              In my voices
            </span>
          ) : (
            <Button type="button" size="sm" variant="ghost" tabIndex={tabIndex} onClick={keep} loading={add.isPending} aria-label={`Add ${g.name} to my voices`}>
              <Plus aria-hidden />
              Add to my voices
            </Button>
          )}
          <Button type="button" size="icon-sm" variant="ghost" tabIndex={tabIndex} aria-pressed={g.starred} aria-label={`Star ${g.name}`} onClick={star} className="ml-auto">
            <Star aria-hidden className={g.starred ? 'fill-current text-studio-accent' : undefined} />
          </Button>
        </div>
        {sample === 'failed' && <p className="text-[11px] text-studio-warning">Couldn't prepare the sample. Check that a GPU worker is running.</p>}
      </div>
    </li>
  )
}
