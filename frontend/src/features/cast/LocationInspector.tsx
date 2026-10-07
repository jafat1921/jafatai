import { useState } from 'react'
import { ImageIcon, Info, Pencil, Trash2, Wand2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/alert-dialog'
import { Kbd } from '@/components/ui/kbd'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { SourceBadge } from '@/components/studio/source-badge'
import { ErrorState } from '@/components/studio/states'
import { GenerationViewer } from '@/components/review/GenerationViewer'
import { StudioImageModelField } from '@/components/models/StudioImageModel'
import { useStudioImageModel } from '@/hooks/useStudioImageModel'
import { useGenerationActions, type GenerationTarget } from '@/hooks/useGenerations'
import { useDeleteLocation } from '@/hooks/useLocations'
import { useScenes } from '@/hooks/useScenes'
import { useProjectAspectClass } from '@/lib/aspect'
import { modKey } from '@/lib/keyboard'
import type { Location } from '@/lib/types'
import { plural } from '@/lib/utils'
import { announce } from '@/stores/ui'
import { LocationDialog } from './LocationDialog'

function EstablishingSection({ location }: { location: Location }) {
  const target: GenerationTarget = { targetType: 'location', targetId: location.id, kind: 'establishing' }
  const { create } = useGenerationActions()
  const aspect = useProjectAspectClass()
  const imageModel = useStudioImageModel(location.project_id)
  const [prompt, setPrompt] = useState(
    `Establishing shot of ${location.name}${location.description ? `, ${location.description}` : ''}, no people, cinematic`,
  )

  const generate = () => {
    if (!prompt.trim() || create.isPending) return
    create.mutate(
      { target, prompt: prompt.trim(), params: imageModel.params },
      { onSuccess: (g) => announce(`Establishing frame version ${g.version} queued.`) },
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <div className="flex items-baseline justify-between">
          <Label htmlFor="establishing-prompt">Prompt</Label>
          <span className="font-mono text-small text-studio-muted">{prompt.length} chars</span>
        </div>
        <Textarea
          id="establishing-prompt"
          rows={4}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              generate()
            }
          }}
        />
      </div>
      <StudioImageModelField projectId={location.project_id} />
      <Button variant="primary" size="lg" className="w-full" onClick={generate} loading={create.isPending} disabled={!prompt.trim()}>
        <Wand2 aria-hidden />
        Generate establishing frame
        <Kbd>{modKey}+Enter</Kbd>
      </Button>
      {create.isError && <ErrorState compact title="Couldn't start the generation" error={create.error} />}
      <div>
        <h3 className="section-label mb-2">Result</h3>
        <GenerationViewer
          target={target}
          subject={`Establishing frame of ${location.name}`}
          aspectClass={aspect}
          emptyHint="No establishing frame yet. Adjust the prompt and press Generate."
        />
      </div>
    </div>
  )
}

export function LocationInspector({ location, projectId }: { location: Location; projectId: string }) {
  const [editing, setEditing] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const remove = useDeleteLocation(projectId)
  const scenes = useScenes(projectId)
  const usedIn = (scenes.data ?? []).filter((s) => s.location_id === location.id)

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <h2 className="min-w-0 flex-1 truncate text-heading font-semibold">{location.name}</h2>
        <SourceBadge source={location.source} locked={location.locked} />
        <Button size="icon-sm" variant="ghost" aria-label={`Edit ${location.name}`} onClick={() => setEditing(true)}>
          <Pencil aria-hidden />
        </Button>
      </div>
      <Tabs defaultValue="frame" className="flex flex-col gap-3">
        <TabsList aria-label="Location sections">
          <TabsTrigger value="frame">
            <ImageIcon aria-hidden />
            Establishing
          </TabsTrigger>
          <TabsTrigger value="details">
            <Info aria-hidden />
            Details
          </TabsTrigger>
        </TabsList>
        <TabsContent value="frame">
          {/* keyed so the prompt resets when switching locations */}
          <EstablishingSection key={location.id} location={location} />
        </TabsContent>
        <TabsContent value="details" className="flex flex-col gap-3">
          <div>
            <h3 className="section-label mb-1">Description</h3>
            <p className="text-body text-studio-muted">{location.description || 'No description yet.'}</p>
          </div>
          <div>
            <h3 className="section-label mb-1">Used in</h3>
            <p className="text-body text-studio-muted">
              {usedIn.length
                ? `${plural(usedIn.length, 'scene')}: ${usedIn.map((s) => s.heading || 'Untitled').join(', ')}`
                : 'No scenes yet. Pick it under a scene in the Scenes column.'}
            </p>
          </div>
          <Button variant="ghost" className="self-start text-studio-danger" onClick={() => setConfirmDelete(true)}>
            <Trash2 aria-hidden />
            Delete location
          </Button>
          {remove.isError && <ErrorState compact title="Couldn't delete" error={remove.error} />}
        </TabsContent>
      </Tabs>

      <LocationDialog
        projectId={projectId}
        open={editing}
        location={location}
        onOpenChange={setEditing}
        onSaved={() => setEditing(false)}
      />
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        tone="danger"
        title={`Delete ${location.name}?`}
        description="Scenes and shots using it lose their location. Its establishing frames stay in history."
        confirmLabel="Delete location"
        onConfirm={() => remove.mutate(location.id, { onSuccess: () => announce(`${location.name} deleted.`) })}
      />
    </div>
  )
}
