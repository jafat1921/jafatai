import { useState } from 'react'
import { Plus, User, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState, ErrorState } from '@/components/studio/states'
import { StatusPill } from '@/components/studio/status-pill'
import { useProjectId, useSelectedCharacter } from '@/features/workspace/selection'
import type { Character } from '@/lib/types'
import { cn, plural } from '@/lib/utils'
import { announce, useUi } from '@/stores/ui'
import { AddCharacterDialog } from './AddCharacterDialog'
import { CharacterSuggestions } from './CharacterSuggestions'
import { ExtractCharactersButton } from './ExtractCharactersButton'
import { LocationsSection } from './LocationsSection'

function CharacterCard({ c, selected, onSelect }: { c: Character; selected: boolean; onSelect: () => void }) {
  const portrait = c.approved_portrait?.media_url
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        'flex flex-col overflow-hidden rounded-[6px] border bg-studio-panel text-left shadow-card transition-colors duration-150',
        selected ? 'border-studio-accent ring-1 ring-studio-accent' : 'border-studio-border-strong hover:bg-studio-panel-hover',
      )}
    >
      <div className="darkroom aspect-square border-x-0 border-t-0">
        {portrait ? (
          <img src={portrait} alt={`Approved portrait of ${c.name}`} className="size-full object-cover" loading="lazy" />
        ) : (
          <div className="flex size-full items-center justify-center text-studio-on-dark-muted">
            <User aria-hidden className="size-8" />
          </div>
        )}
      </div>
      <div className="flex flex-col gap-1.5 p-2.5">
        <span className="truncate font-display text-panel font-semibold">{c.name}</span>
        {c.description && <span className="line-clamp-2 text-small text-studio-muted">{c.description}</span>}
        <StatusPill
          className="self-start"
          status={
            c.approved_portrait
              ? { label: 'Portrait approved', tone: 'success', icon: 'check' }
              : { label: 'No portrait yet', tone: 'neutral', icon: 'clock' }
          }
        />
      </div>
    </button>
  )
}

export function CastCanvas() {
  const projectId = useProjectId()
  const { characters, character, select } = useSelectedCharacter()
  const [adding, setAdding] = useState(false)
  const [aiError, setAiError] = useState<unknown>(null)
  const list = characters.data ?? []

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-start justify-between gap-3 px-5 pb-3 pt-4">
        <div>
          <h1 className="text-title font-display font-semibold">Cast &amp; World</h1>
          <p className="text-small text-studio-muted">
            {characters.data ? plural(list.length, 'character') : 'Characters'} · approve a portrait for each, and an establishing frame per location, before storyboarding
          </p>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <ExtractCharactersButton projectId={projectId} onError={setAiError} />
          <Button variant="primary" onClick={() => setAdding(true)}>
            <Plus aria-hidden />
            Add character
          </Button>
        </div>
      </header>
      {aiError ? (
        <div className="px-5 pb-3">
          <ErrorState compact title="Couldn't extract characters" error={aiError} />
        </div>
      ) : null}
      <CharacterSuggestions projectId={projectId} />

      <ScrollArea className="min-h-0 flex-1">
        <div className="px-5 pb-6">
          {characters.isPending && (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3" role="status" aria-label="Loading characters">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="aspect-[3/4]" />
              ))}
            </div>
          )}
          {characters.isError && <ErrorState error={characters.error} onRetry={() => characters.refetch()} />}
          {characters.isSuccess && list.length === 0 && (
            <EmptyState
              icon={<Users />}
              title="No characters yet"
              action={
                <Button variant="primary" onClick={() => setAdding(true)}>
                  <Plus aria-hidden />
                  Add character
                </Button>
              }
            >
              Add the people in your film. Each gets a portrait you approve, which keeps them consistent in every shot.
            </EmptyState>
          )}
          {list.length > 0 && (
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
              {list.map((c) => (
                <li key={c.id} className="flex [&>button]:w-full">
                  <CharacterCard c={c} selected={character?.id === c.id} onSelect={() => {
                      select(c.id)
                      // only matters below 1280px, where the Inspector is a slide-over
                      useUi.getState().setInspectorOpen(true)
                    }}
                  />
                </li>
              ))}
            </ul>
          )}
          <LocationsSection projectId={projectId} />
        </div>
      </ScrollArea>

      <AddCharacterDialog
        projectId={projectId}
        open={adding}
        onOpenChange={setAdding}
        onCreated={(c) => {
          setAdding(false)
          select(c.id)
          announce(`${c.name} added. Generate a portrait in the Inspector.`)
        }}
      />
    </div>
  )
}
