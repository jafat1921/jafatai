import { useId, useState } from 'react'
import { useNavigate } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { RadioGroup } from 'radix-ui'
import { FileText, Minus, Moon, PenLine, Plus, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Kbd } from '@/components/ui/kbd'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { AspectTiles } from '@/components/studio/aspect-tile'
import { ErrorState } from '@/components/studio/states'
import { useCreateProject } from '@/hooks/useProjects'
import { upsertJob } from '@/hooks/useJobs'
import { api } from '@/lib/api'
import type { AuthoringMode, ProjectCreate, Quality } from '@/lib/types'
import { modKey } from '@/lib/keyboard'
import { cn } from '@/lib/utils'

const MODES: { value: AuthoringMode; title: string; blurb: string; icon: typeof Sparkles; disabled?: boolean }[] = [
  {
    value: 'ai_director',
    title: 'AI Director',
    blurb: 'Give a one-line brief and runtime. The AI drafts the outline and every scene.',
    icon: Sparkles,
  },
  {
    value: 'scene_by_scene',
    title: 'Scene by scene',
    blurb: 'Write each scene yourself. Ask the AI for help only where you want it.',
    icon: PenLine,
  },
  {
    value: 'import',
    title: 'Import screenplay',
    blurb: 'Bring a Fountain or FDX file and split it into scenes.',
    icon: FileText,
    disabled: true,
  },
]

const RUNTIMES = [
  { s: 60, label: '1 min' },
  { s: 120, label: '2 min' },
  { s: 300, label: '5 min' },
  { s: 900, label: '15 min' },
  { s: 3600, label: '1 h' },
  { s: 7200, label: '2 h' },
]

export function NewProjectDialog({
  open,
  onOpenChange,
  initial,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  // from a studio template; the user still confirms
  initial?: Partial<ProjectCreate>
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">{open && <NewProjectForm initial={initial} onDone={() => onOpenChange(false)} />}</DialogContent>
    </Dialog>
  )
}

const nearestRuntime = (s: number) => RUNTIMES.map((r) => r.s).reduce((a, b) => (Math.abs(b - s) < Math.abs(a - s) ? b : a))

function NewProjectForm({ onDone, initial }: { onDone: () => void; initial?: Partial<ProjectCreate> }) {
  const ids = { mode: useId(), aspect: useId(), runtime: useId(), quality: useId() }
  const navigate = useNavigate()
  const create = useCreateProject()
  const qc = useQueryClient()

  const [mode, setMode] = useState<AuthoringMode>(initial?.authoring_mode === 'scene_by_scene' ? 'scene_by_scene' : 'ai_director')
  const [title, setTitle] = useState(initial?.title ?? '')
  const [brief, setBrief] = useState(initial?.logline ?? '')
  const [runtime, setRuntime] = useState(initial?.target_runtime_s ? nearestRuntime(initial.target_runtime_s) : 120)
  const [aspect, setAspect] = useState(initial?.aspect_ratio ?? '16:9')
  const [quality, setQuality] = useState<Quality>('draft')
  const [takes, setTakes] = useState(3)
  const [overnight, setOvernight] = useState(false)

  const canSubmit = title.trim().length > 0 && (mode !== 'ai_director' || brief.trim().length > 0)

  const submit = () => {
    if (!canSubmit) return
    const text = brief.trim()
    create.mutate(
      {
        title: title.trim(),
        authoring_mode: mode,
        // the brief is the AI Director's instruction; scene-by-scene just gets a logline
        ...(mode === 'ai_director' ? { brief: text, logline: text.split('\n')[0].slice(0, 200) } : { logline: text }),
        aspect_ratio: aspect,
        target_runtime_s: runtime,
        quality,
        takes_per_shot: takes,
        overnight,
      },
      {
        onSuccess: (p) => {
          // AI Director projects start outlining straight away; the Script stage shows the progress
          if (p.authoring_mode === 'ai_director') {
            api.ai.outline(p.id).then((job) => upsertJob(qc, job)).catch(() => {
              /* the Script stage offers "Start the outline" if this didn't queue */
            })
          }
          onDone()
          navigate(`/projects/${p.id}/script`)
        },
      },
    )
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault()
          submit()
        }
      }}
      className="flex flex-col gap-5"
    >
      <DialogHeader className="mb-0">
        <DialogTitle>New project</DialogTitle>
        <DialogDescription>Choose how you want to write it. You can mix AI and your own scenes later.</DialogDescription>
      </DialogHeader>

      <div>
        <div id={ids.mode} className="section-label mb-2">
          How do you want to start?
        </div>
        <RadioGroup.Root
          aria-labelledby={ids.mode}
          value={mode}
          onValueChange={(v) => setMode(v as AuthoringMode)}
          className="grid gap-2 sm:grid-cols-3"
        >
          {MODES.map((m) => (
            <RadioGroup.Item
              key={m.value}
              value={m.value}
              disabled={m.disabled}
              aria-labelledby={`mode-${m.value}-title`}
              aria-describedby={`mode-${m.value}-blurb`}
              className={cn(
                'flex flex-col items-start gap-1.5 rounded-[6px] border p-3 text-left transition-colors duration-150',
                'border-studio-border-strong bg-studio-raised hover:bg-studio-panel-hover',
                'data-[state=checked]:border-studio-accent data-[state=checked]:bg-studio-accent-soft',
                'data-[disabled]:cursor-not-allowed data-[disabled]:opacity-60 data-[disabled]:hover:bg-studio-raised',
              )}
            >
              <span className="flex w-full items-center gap-2">
                <m.icon aria-hidden className="size-4 text-studio-accent-hover" />
                <span id={`mode-${m.value}-title`} className="text-heading font-semibold">
                  {m.title}
                </span>
              </span>
              <span id={`mode-${m.value}-blurb`} className="text-small text-studio-muted">
                {m.blurb}
                {m.disabled && <span className="sr-only"> Coming next.</span>}
              </span>
              {m.disabled && (
                <span aria-hidden className="rounded-full border border-studio-border-strong px-2 text-small text-studio-muted">
                  Coming next
                </span>
              )}
            </RadioGroup.Item>
          ))}
        </RadioGroup.Root>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="np-title">Title</Label>
        <Input id="np-title" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. The Bleaching Reef" />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="np-brief">{mode === 'ai_director' ? 'Brief' : 'Logline (optional)'}</Label>
        <Textarea
          id="np-brief"
          rows={mode === 'ai_director' ? 3 : 2}
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          placeholder={
            mode === 'ai_director'
              ? 'A 2-hour ocean documentary with a calm narrator, following one diver across a year…'
              : 'A diver discovers the reef is bleaching.'
          }
        />
        {mode === 'ai_director' && (
          <p className="text-small text-studio-muted">The AI Director uses this to write the outline and scenes.</p>
        )}
      </div>

      <div>
        <div id={ids.runtime} className="section-label mb-2">
          Target runtime
        </div>
        <ToggleGroup
          type="single"
          aria-labelledby={ids.runtime}
          value={String(runtime)}
          onValueChange={(v) => v && setRuntime(Number(v))}
          className="grid w-full grid-cols-3 sm:flex"
        >
          {RUNTIMES.map((r) => (
            <ToggleGroupItem key={r.s} value={String(r.s)}>
              {r.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      <div>
        <div id={ids.aspect} className="section-label mb-2">
          Aspect ratio
        </div>
        <AspectTiles value={aspect} onChange={setAspect} labelledBy={ids.aspect} />
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <div id={ids.quality} className="section-label mb-2">
            Quality
          </div>
          <ToggleGroup
            type="single"
            aria-labelledby={ids.quality}
            value={quality}
            onValueChange={(v) => v && setQuality(v as Quality)}
            className="flex w-full"
          >
            <ToggleGroupItem value="draft">Draft</ToggleGroupItem>
            <ToggleGroupItem value="final">Final</ToggleGroupItem>
          </ToggleGroup>
        </div>
        <div>
          <div className="section-label mb-2" id="np-takes-label">
            Takes per shot
          </div>
          <div className="flex items-center gap-1" role="group" aria-labelledby="np-takes-label">
            <Button type="button" size="icon" aria-label="Fewer takes" onClick={() => setTakes((t) => Math.max(1, t - 1))} disabled={takes <= 1}>
              <Minus aria-hidden />
            </Button>
            <output className="w-10 text-center font-mono text-body" aria-live="polite">
              {takes}
            </output>
            <Button type="button" size="icon" aria-label="More takes" onClick={() => setTakes((t) => Math.min(8, t + 1))} disabled={takes >= 8}>
              <Plus aria-hidden />
            </Button>
          </div>
        </div>
        <label className="flex cursor-pointer items-start gap-2.5 rounded-[6px] border border-studio-border-strong bg-studio-raised p-2.5">
          <Switch checked={overnight} onCheckedChange={setOvernight} aria-describedby="np-overnight-hint" className="mt-0.5" />
          <span>
            <span className="flex items-center gap-1 text-body font-medium">
              <Moon aria-hidden className="size-3.5" /> Overnight mode
            </span>
            <span id="np-overnight-hint" className="block text-small text-studio-muted">
              Auto-approve by score and keep rendering while you sleep.
            </span>
          </span>
        </label>
      </div>

      {create.isError && <ErrorState compact title="Couldn't create the project" error={create.error} />}

      <DialogFooter className="sticky -bottom-5 z-10 -mx-5 -mb-5 mt-0 border-t border-studio-border bg-studio-panel px-5 py-3">
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          disabled={!canSubmit}
          loading={create.isPending}
          aria-keyshortcuts="Control+Enter"
        >
          Create project
          <Kbd>{modKey}+Enter</Kbd>
        </Button>
      </DialogFooter>
    </form>
  )
}
