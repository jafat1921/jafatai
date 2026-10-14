import { useEffect, useId, useRef, useState } from 'react'
import { Loader2, Sparkles, Wand2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { ErrorState } from '@/components/studio/states'
import { GenerationViewer } from '@/components/review/GenerationViewer'
import { StudioImageModelField } from '@/components/models/StudioImageModel'
import { useStudioImageModel } from '@/hooks/useStudioImageModel'
import { useGenerationActions, type GenerationTarget } from '@/hooks/useGenerations'
import { useAiJob } from '@/hooks/useAi'
import { useUploadPortrait } from '@/hooks/useCharacterStudio'
import { api } from '@/lib/api'
import { modKey } from '@/lib/keyboard'
import type { Character } from '@/lib/types'
import { announce } from '@/stores/ui'
import { OwnImageUpload } from './OwnImageUpload'

// shared by the film's Cast inspector and Character Studio; a studio character has no project
export function PortraitSection({ character }: { character: Character }) {
  const target: GenerationTarget = { targetType: 'character', targetId: character.id, kind: 'portrait' }
  const { create } = useGenerationActions()
  const upload = useUploadPortrait(character.id)
  const ownId = useId()
  const imageModel = useStudioImageModel(character.project_id ?? '')
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
      <StudioImageModelField projectId={character.project_id ?? ''} />
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

      <section aria-labelledby={ownId} className="flex flex-col gap-2 rounded-[6px] border border-studio-border bg-studio-raised p-3">
        <h3 id={ownId} className="section-label">Or use your own picture</h3>
        <p className="text-small text-studio-muted">
          {character.approved_portrait
            ? 'It comes in as a new version, used exactly as it is. Approve it below to make it the portrait.'
            : 'Used exactly as it is, and approved straight away as the portrait.'}
        </p>
        <OwnImageUpload
          label="Upload portrait"
          title={`Portrait of ${character.name}`}
          busy={upload.isPending}
          onUploaded={(m, consent) =>
            upload.mutate(
              { media_id: m.id, consent },
              {
                onSuccess: (g) =>
                  announce(g.status === 'approved' ? 'Your picture is now the portrait.' : `Your picture is portrait version ${g.version}. Approve it to use it.`),
              },
            )
          }
        />
        {upload.isError && <ErrorState compact title="Couldn't use that picture" error={upload.error} />}
      </section>

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
