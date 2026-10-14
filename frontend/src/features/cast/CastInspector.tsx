import { ImageIcon, LibraryBig, MousePointerClick, UserRound } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { SourceBadge } from '@/components/studio/source-badge'
import { EmptyState } from '@/components/studio/states'
import { useProjectId, useSelectedCharacter, useSelectedLocation } from '@/features/workspace/selection'
import { CastCompact } from '@/features/characters/CastCompact'
import { PortraitSection } from '@/features/characters/PortraitSection'
import { LocationInspector } from './LocationInspector'

export function CastInspector() {
  const projectId = useProjectId()
  const { character } = useSelectedCharacter()
  const { location } = useSelectedLocation()
  if (location && !character) return <LocationInspector location={location} projectId={projectId} />
  if (!character) {
    return (
      <EmptyState icon={<MousePointerClick />} title="Nothing selected">
        Pick a character or a location on the canvas to generate and review its reference image.
      </EmptyState>
    )
  }
  const studio = character.project_id === null
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <h2 dir="auto" className="min-w-0 flex-1 truncate text-heading font-semibold">
          {character.name}
        </h2>
        {studio ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-studio-gold/70 bg-studio-gold/10 px-2 text-small">
            <LibraryBig aria-hidden className="size-3" />
            Character Studio
          </span>
        ) : (
          <SourceBadge source={character.source} locked={character.locked} />
        )}
      </div>
      <Tabs defaultValue="portrait" className="flex flex-col gap-3">
        <TabsList aria-label="Character sections">
          <TabsTrigger value="portrait">
            <ImageIcon aria-hidden />
            Portrait
          </TabsTrigger>
          <TabsTrigger value="character">
            <UserRound aria-hidden />
            Sheet &amp; voice
          </TabsTrigger>
        </TabsList>
        <TabsContent value="portrait">
          {/* keyed so the prompt resets when switching characters */}
          <PortraitSection key={character.id} character={character} />
        </TabsContent>
        <TabsContent value="character">
          <CastCompact key={character.id} character={character} projectId={projectId} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
