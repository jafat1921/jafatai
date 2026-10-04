import { useRef, useState } from 'react'
import { AlertTriangle, Check, Loader2, Lock, PenLine, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { SourceBadge } from '@/components/studio/source-badge'
import { EmptyState, ErrorState } from '@/components/studio/states'
import { StatusPill } from '@/components/studio/status-pill'
import { useUpdateScene } from '@/hooks/useScenes'
import { staleStatus } from '@/lib/status'
import type { Scene } from '@/lib/types'
import { cn } from '@/lib/utils'
import { useProjectId } from '@/features/workspace/selection'
import { useAutosave, type SaveState } from './useAutosave'
import { flushLeft } from './flushLeft'
import { AiAssistMenu, type AssistRequest } from './AiAssistMenu'
import { AiDraftForm } from './AiDraftForm'
import { SceneSuggestions } from './SceneSuggestions'
import { useAiJob } from '@/hooks/useAi'
import { api } from '@/lib/api'

type Draft = Pick<Scene, 'heading' | 'logline' | 'script_text'>


function SaveIndicator({ state, onRetry }: { state: SaveState; onRetry: () => void }) {
  if (state === 'saving')
    return (
      <span className="inline-flex items-center gap-1 text-small text-studio-muted">
        <Loader2 aria-hidden className="size-3 animate-spin" /> Saving…
      </span>
    )
  if (state === 'saved')
    return (
      <span className="inline-flex items-center gap-1 text-small text-studio-muted">
        <Check aria-hidden className="size-3 text-studio-success" /> Saved
      </span>
    )
  if (state === 'dirty') return <span className="text-small text-studio-muted">Unsaved changes</span>
  if (state === 'error')
    return (
      <span role="alert" className="inline-flex items-center gap-1.5 text-small text-studio-danger">
        <AlertTriangle aria-hidden className="size-3" /> Couldn&apos;t save
        <Button size="sm" variant="ghost" className="h-6 px-1.5" onClick={onRetry}>
          Retry
        </Button>
      </span>
    )
  return null
}

export function SceneEditor({ scene, index }: { scene: Scene; index: number }) {
  const update = useUpdateScene(useProjectId())
  const [draft, setDraft] = useState<Draft>({
    heading: scene.heading ?? '',
    logline: scene.logline ?? '',
    script_text: scene.script_text ?? '',
  })
  const isEmpty = !draft.heading.trim() && !draft.logline.trim() && !draft.script_text.trim()
  const [writing, setWriting] = useState(!isEmpty)
  const [drafting, setDrafting] = useState(false)
  const scriptRef = useRef<HTMLTextAreaElement>(null)
  const assist = useAiJob((req: AssistRequest) => api.ai.assist(scene.id, req))

  const autosave = useAutosave<Draft>((patch) => update.mutateAsync({ id: scene.id, patch }))

  const edit = (field: keyof Draft, value: string) => {
    setDraft((d) => ({ ...d, [field]: value }))
    autosave.change({ [field]: value })
  }

  const onScriptPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = e.clipboardData.getData('text/plain')
    const clean = flushLeft(pasted)
    if (clean === pasted) return
    e.preventDefault()
    const el = e.currentTarget
    const { selectionStart: start, selectionEnd: end } = el
    const next = draft.script_text.slice(0, start) + clean + draft.script_text.slice(end)
    edit('script_text', next)
    requestAnimationFrame(() => el.setSelectionRange(start + clean.length, start + clean.length))
  }

  const onScriptBlur = () => {
    const clean = flushLeft(draft.script_text)
    if (clean !== draft.script_text) edit('script_text', clean)
    void autosave.flush()
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      void autosave.flush()
    }
  }

  if (!writing) {
    return (
      <EmptyState
        className="h-full"
        icon={<PenLine />}
        title={`Scene ${index + 1} is empty`}
        action={
          drafting ? (
            <AiDraftForm sceneId={scene.id} onCancel={() => setDrafting(false)} />
          ) : (
            <>
              <Button
                variant="primary"
                onClick={() => {
                  setWriting(true)
                  requestAnimationFrame(() => scriptRef.current?.focus())
                }}
              >
                <PenLine aria-hidden />
                Write it
              </Button>
              <Button variant="secondary" onClick={() => setDrafting(true)}>
                <Sparkles aria-hidden />
                Let AI draft
              </Button>
            </>
          )
        }
      >
        Write the action and dialogue yourself, or let the AI draft it from the scenes around it.
      </EmptyState>
    )
  }

  return (
    <div className="flex h-full flex-col" onKeyDown={onKeyDown}>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-studio-border px-5 py-3">
        <h1 className="text-title font-display font-semibold">
          Scene {index + 1}
          <span className="sr-only"> script</span>
        </h1>
        <SourceBadge source={scene.source} />
        {scene.locked && (
          <span className="inline-flex items-center gap-1 text-small text-studio-muted" title="You edited this scene, so AI won't overwrite it">
            <Lock aria-hidden className="size-3" /> Locked
          </span>
        )}
        <span className="font-mono text-small text-studio-muted" aria-label={`Version ${scene.version}`}>
          v{scene.version}
        </span>
        {scene.stale && <StatusPill status={staleStatus} />}
        <div className="ml-auto flex items-center gap-3">
          <SaveIndicator state={autosave.state} onRetry={() => void autosave.flush()} />
          <AiAssistMenu
            hasScript={!!draft.script_text.trim()}
            working={assist.working}
            status={assist.job?.status === 'queued' ? 'Waiting for a worker…' : assist.job?.message}
            onAction={(req) => {
              // save first so the AI works from what's on screen
              void autosave.flush().then(() => assist.run(req))
            }}
          />
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-4 px-5 py-5">
          {assist.error && (
            <ErrorState compact title="AI Assist didn't finish" error={assist.error} onRetry={assist.reset} />
          )}
          <SceneSuggestions scene={scene} live={draft} beforeAccept={autosave.flush} />
          <div className="flex flex-col gap-1.5">
            <label htmlFor="scene-heading" className="section-label">
              Heading
            </label>
            <Input
              id="scene-heading"
              value={draft.heading}
              onChange={(e) => edit('heading', e.target.value)}
              onBlur={() => void autosave.flush()}
              placeholder="EXT. CORAL REEF – DAY"
              className="h-9 font-script text-[14px] uppercase"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="scene-logline" className="section-label">
              Logline
            </label>
            <Input
              id="scene-logline"
              value={draft.logline}
              onChange={(e) => edit('logline', e.target.value)}
              onBlur={() => void autosave.flush()}
              placeholder="One sentence: what happens in this scene?"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between">
              <label htmlFor="scene-script" className="section-label">
                Script
              </label>
              <span className="font-mono text-small text-studio-muted">
                {draft.script_text.trim() ? draft.script_text.trim().split(/\s+/).length : 0} words
              </span>
            </div>
            <Textarea
              id="scene-script"
              ref={scriptRef}
              value={draft.script_text}
              onChange={(e) => edit('script_text', e.target.value)}
              onPaste={onScriptPaste}
              onBlur={onScriptBlur}
              spellCheck
              placeholder={'The DIVER drifts over pale coral, slowing as the colour drains away.\n\nNARRATOR (V.O.)\nTen years ago, this reef was alive with colour.'}
              className={cn(
                'paper-fine min-h-[55vh] resize-y px-6 py-5 font-script text-[14px] leading-[22px] shadow-card',
              )}
            />
            <p className="text-small text-studio-muted">
              Saves automatically. Anything you write is locked — AI will suggest changes, never overwrite them.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
