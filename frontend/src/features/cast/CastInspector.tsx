import { useEffect, useRef, useState } from 'react'
import { ImageIcon, Loader2, MousePointerClick, Sparkles, UserRound, Wand2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { SourceBadge } from '@/components/studio/source-badge'
import { EmptyState, ErrorState } from '@/components/studio/states'
import { GenerationViewer } from '@/components/review/GenerationViewer'
import { StudioImageModelField } from '@/components/models/StudioImageModel'
import { useStudioImageModel } from '@/hooks/useStudioImageModel'
import { useGenerationActions, type GenerationTarget } from '@/hooks/useGenerations'
import { useAiJob } from '@/hooks/useAi'
import { api } from '@/lib/api'
import { useProjectId, useSelectedCharacter, useSelectedLocation } from '@/features/workspace/selection'
import { LocationInspector } from './LocationInspector'
import { modKey } from '@/lib/keyboard'
import type { Character } from '@/lib/types'
import { announce } from '@/stores/ui'

function PortraitSection({ character }: { character: Character }) {
  const target: GenerationTarget = { targetType: 'character', targetId: character.id, kind: 'portrait' }
  const { create } = useGenerationActions()
  const imageModel = useStudioImageModel(character.project_id)
  const [prompt, setPrompt] = useState(
    character.description ? `Portrait of ${character.name}, ${character.description}` : `Portrait of ${character.name}`,
  )

  const writer = useAiJob(() => api.ai.portraitPrompt(character.id))
  const applied = useRef<string | null>(null)
  const written = writer.job?.status === 'done' ? writer.job.result?.prompt : undefined
  useEffect(() => {
    // fill the textarea once per finished job; later edits by the user stay theirs
    if (written && writer.job && applied.current !== writer.job.id) {
      applied.current = writer.job.id
      setPrompt(written)
      announce('Portrait prompt written. Review it, then Generate.')
    }
  }, [written, writer.job])

  const generate = () => {
    if (!prompt.trim() || create.isPending) return
    create.mutate(
      { target, prompt: prompt.trim(), params: imageModel.params },
      { onSuccess: (g) => announce(`Portrait version ${g.version} queued.`) },
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <div className="flex items-baseline justify-between">
          <Label htmlFor="portrait-prompt">Prompt</Label>
          <span className="font-mono text-small text-studio-muted">{prompt.length} chars</span>
        </div>
        <Button
          size="sm"
          variant="secondary"
          className="self-start"
          onClick={() => writer.run(undefined)}
          disabled={writer.working}
          aria-describedby="portrait-writer-status"
        >
          {writer.working ? <Loader2 aria-hidden className="animate-spin" /> : <Sparkles aria-hidden />}
          Write prompt for me
        </Button>
        <p id="portrait-writer-status" role="status" className="text-small text-studio-muted empty:hidden">
          {writer.working ? (writer.job?.status === 'running' ? writer.job.message : 'Waiting for a worker…') : ''}
        </p>
        {writer.error && <ErrorState compact title="The AI couldn't write a prompt" error={writer.error} />}
        <Textarea
          id="portrait-prompt"
          rows={5}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              generate()
            }
          }}
          placeholder="Describe the face, age, hair, wardrobe and lighting…"
        />
      </div>
      <StudioImageModelField projectId={character.project_id} />
      <Button
        variant="primary"
        size="lg"
        className="w-full"
        onClick={generate}
        loading={create.isPending}
        disabled={!prompt.trim()}
        aria-keyshortcuts="Control+Enter"
      >
        <Wand2 aria-hidden />
        Generate portrait
        <Kbd>{modKey}+Enter</Kbd>
      </Button>
      {create.isError && <ErrorState compact title="Couldn't start the generation" error={create.error} />}

      <div>
        <h3 className="section-label mb-2">Result</h3>
        <GenerationViewer
          target={target}
          subject={`Portrait of ${character.name}`}
          emptyHint="No portrait yet. Write a prompt above and press Generate."
        />
      </div>
      <p className="text-small text-studio-muted">
        Shortcuts when not typing: <Kbd>A</Kbd> approve · <Kbd>R</Kbd> regenerate · <Kbd>X</Kbd> reject · <Kbd>V</Kbd> versions · <Kbd>U</Kbd> upscale
      </p>
    </div>
  )
}

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
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <h2 className="min-w-0 flex-1 truncate text-heading font-semibold">{character.name}</h2>
        <SourceBadge source={character.source} locked={character.locked} />
      </div>
      <Tabs defaultValue="portrait" className="flex flex-col gap-3">
        <TabsList aria-label="Character sections">
          <TabsTrigger value="portrait">
            <ImageIcon aria-hidden />
            Portrait
          </TabsTrigger>
          <TabsTrigger value="details">
            <UserRound aria-hidden />
            Details
          </TabsTrigger>
        </TabsList>
        <TabsContent value="portrait">
          {/* keyed so the prompt resets when switching characters */}
          <PortraitSection key={character.id} character={character} />
        </TabsContent>
        <TabsContent value="details">
          <h3 className="section-label mb-1">Description</h3>
          <p className="text-body text-studio-muted">{character.description || 'No description yet.'}</p>
          <p className="mt-4 text-small text-studio-muted">
            Character sheets (front, ¾, side, back) and LoRA binding arrive in a later milestone.
          </p>
        </TabsContent>
      </Tabs>
    </div>
  )
}
