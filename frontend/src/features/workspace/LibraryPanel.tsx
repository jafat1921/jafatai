import { useState } from 'react'
import { useNavigate } from 'react-router'
import { Box, MapPin, Palette, Search, Sparkle, User, Users } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { Chip } from '@/components/studio/chip'
import { Section } from '@/components/studio/section'
import { ErrorState } from '@/components/studio/states'
import type { Character, Location } from '@/lib/types'
import { cn } from '@/lib/utils'
import { useProjectId, useSelectedCharacter, useSelectedLocation } from './selection'

const CATEGORIES = ['all', 'characters', 'locations', 'props', 'styles', 'loras'] as const
type Category = (typeof CATEGORIES)[number]

const LABELS: Record<Category, string> = {
  all: 'All',
  characters: 'Characters',
  locations: 'Locations',
  props: 'Props',
  styles: 'Styles',
  loras: 'LoRAs',
}

// Asset types that don't have an API yet in M1 — shown so the library structure is learnable now.
const UPCOMING: { cat: Category; icon: typeof MapPin; hint: string }[] = [
  { cat: 'props', icon: Box, hint: 'Recurring objects you want kept consistent.' },
  { cat: 'styles', icon: Palette, hint: 'Style frames that set the film’s look.' },
  { cat: 'loras', icon: Sparkle, hint: 'Character and style LoRAs bound to assets.' },
]

function CharacterThumb({ c, selected, onSelect }: { c: Character; selected: boolean; onSelect: () => void }) {
  const portrait = c.approved_portrait?.media_url
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        'darkroom group relative aspect-square overflow-hidden rounded-[6px] text-left',
        selected ? 'border-studio-accent ring-2 ring-studio-accent' : 'hover:brightness-110',
      )}
    >
      {portrait ? (
        <img src={portrait} alt={`Portrait of ${c.name}`} className="size-full object-cover" loading="lazy" />
      ) : (
        <span className="flex size-full items-center justify-center text-studio-on-dark-muted">
          <User aria-hidden className="size-5" />
        </span>
      )}
      <span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-studio-darkroom to-transparent px-1.5 pb-1 pt-3 text-small font-medium text-studio-on-dark">
        {c.name}
      </span>
    </button>
  )
}

function LocationThumb({ l, selected, onSelect }: { l: Location; selected: boolean; onSelect: () => void }) {
  const frame = l.approved_establishing?.media_url
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        'darkroom group relative aspect-video overflow-hidden rounded-[6px] text-left',
        selected ? 'border-studio-accent ring-2 ring-studio-accent' : 'hover:brightness-110',
      )}
    >
      {frame ? (
        <img src={frame} alt={`Establishing frame of ${l.name}`} className="size-full object-cover" loading="lazy" />
      ) : (
        <span className="flex size-full items-center justify-center text-studio-on-dark-muted">
          <MapPin aria-hidden className="size-5" />
        </span>
      )}
      <span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-studio-darkroom to-transparent px-1.5 pb-1 pt-3 text-small font-medium text-studio-on-dark">
        {l.name}
      </span>
    </button>
  )
}

export function LibraryPanel() {
  const projectId = useProjectId()
  const navigate = useNavigate()
  const { characters, character, select } = useSelectedCharacter()
  const { locations, location, select: selectLocation } = useSelectedLocation()
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<Category>('all')

  const q = query.trim().toLowerCase()
  const chars = (characters.data ?? []).filter((c) => !q || c.name.toLowerCase().includes(q))
  const locs = (locations.data ?? []).filter((l) => !q || l.name.toLowerCase().includes(q))
  const show = (c: Category) => category === 'all' || category === c

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-col gap-2 border-b border-studio-border p-3">
        <div className="relative">
          <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-studio-muted" />
          <Input
            type="search"
            placeholder="Search assets"
            aria-label="Search library"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-8"
          />
        </div>
        <div className="flex flex-wrap gap-1" role="group" aria-label="Asset category">
          {CATEGORIES.map((c) => (
            <Chip key={c} selected={category === c} onClick={() => setCategory(c)} className="h-6">
              {LABELS[c]}
            </Chip>
          ))}
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col p-2">
          {show('characters') && (
            <Section title="Characters" count={characters.data ? chars.length : undefined} icon={<Users aria-hidden className="size-3.5 text-studio-accent-hover" />}>
              {characters.isPending && (
                <div className="grid grid-cols-3 gap-1.5">
                  {[0, 1, 2].map((i) => (
                    <Skeleton key={i} className="aspect-square" />
                  ))}
                </div>
              )}
              {characters.isError && <ErrorState compact error={characters.error} onRetry={() => characters.refetch()} />}
              {characters.isSuccess && chars.length === 0 && (
                <p className="px-1 pb-2 text-small text-studio-muted">
                  {q ? 'No characters match.' : 'No characters yet. Add them in Cast & World.'}
                </p>
              )}
              {chars.length > 0 && (
                <div className="grid grid-cols-3 gap-1.5">
                  {chars.map((c) => (
                    <CharacterThumb
                      key={c.id}
                      c={c}
                      selected={character?.id === c.id}
                      onSelect={() => {
                        select(c.id)
                        navigate(`/projects/${projectId}/cast`)
                      }}
                    />
                  ))}
                </div>
              )}
            </Section>
          )}

          {show('locations') && (
            <Section title="Locations" count={locations.data ? locs.length : undefined} icon={<MapPin aria-hidden className="size-3.5 text-studio-accent-hover" />}>
              {locations.isPending && <Skeleton className="aspect-video" />}
              {locations.isError && <ErrorState compact error={locations.error} onRetry={() => locations.refetch()} />}
              {locations.isSuccess && locs.length === 0 && (
                <p className="px-1 pb-2 text-small text-studio-muted">
                  {q ? 'No locations match.' : 'No locations yet. Add or extract them in Cast & World.'}
                </p>
              )}
              {locs.length > 0 && (
                <div className="grid grid-cols-2 gap-1.5">
                  {locs.map((l) => (
                    <LocationThumb
                      key={l.id}
                      l={l}
                      selected={location?.id === l.id}
                      onSelect={() => {
                        selectLocation(l.id)
                        navigate(`/projects/${projectId}/cast`)
                      }}
                    />
                  ))}
                </div>
              )}
            </Section>
          )}

          {UPCOMING.filter((u) => show(u.cat) && !q).map((u) => (
            <Section
              key={u.cat}
              title={LABELS[u.cat]}
              count={0}
              defaultOpen={category === u.cat}
              icon={<u.icon aria-hidden className="size-3.5 text-studio-muted" />}
            >
              <p className="px-1 pb-2 text-small text-studio-muted">{u.hint} Arrives in a later milestone.</p>
            </Section>
          ))}
        </div>
      </ScrollArea>
    </div>
  )
}
