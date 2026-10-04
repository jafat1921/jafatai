import { useId, useState } from 'react'
import { Link2, Wand2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import { buildStoryboardRequest, DEFAULT_STORYBOARD_FORM, type StoryboardForm } from '@/lib/shots'
import type { StoryboardRequest } from '@/lib/types'
import { cn, plural } from '@/lib/utils'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  selectedSceneId?: string
  selectedSceneLabel?: string
  initialScope?: 'all' | 'selected'
  scenesWithShots: number
  onSubmit: (body: StoryboardRequest) => void
  pending?: boolean
}

export function StoryboardDialog(props: Props) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>{props.open && <Form {...props} />}</DialogContent>
    </Dialog>
  )
}

function Option({
  name,
  value,
  checked,
  onChange,
  title,
  hint,
}: {
  name: string
  value: string
  checked: boolean
  onChange: () => void
  title: string
  hint: string
}) {
  return (
    <label
      className={cn(
        'flex gap-2.5 rounded-[6px] border p-2.5 transition-colors duration-150',
        checked ? 'border-studio-accent bg-studio-accent-soft' : 'border-studio-border-strong bg-studio-raised hover:bg-studio-panel-hover',
      )}
    >
      <input type="radio" name={name} value={value} checked={checked} onChange={onChange} className="mt-1 accent-[var(--accent)]" />
      <span className="flex flex-col">
        <span className="text-body font-medium">{title}</span>
        <span className="text-small text-studio-muted">{hint}</span>
      </span>
    </label>
  )
}

function Form({ selectedSceneId, selectedSceneLabel, initialScope, scenesWithShots, onSubmit, pending, onOpenChange }: Props) {
  const [form, setForm] = useState<StoryboardForm>({
    ...DEFAULT_STORYBOARD_FORM,
    scope: initialScope && selectedSceneId ? initialScope : 'all',
  })
  const set = (patch: Partial<StoryboardForm>) => setForm((f) => ({ ...f, ...patch }))
  const ids = useId()

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit(buildStoryboardRequest(form, selectedSceneId))
      }}
    >
      <DialogHeader className="mb-0">
        <DialogTitle>Storyboard from script</DialogTitle>
        <DialogDescription>
          The AI reads each scene and writes how it opens and how it ends, then draws those frames from your approved cast and
          locations.
        </DialogDescription>
      </DialogHeader>

      <fieldset className="flex flex-col gap-1.5">
        <legend className="section-label mb-1.5">Mode</legend>
        <Option
          name={`${ids}-mode`}
          value="scene"
          checked={form.mode === 'scene'}
          onChange={() => set({ mode: 'scene' })}
          title="First & last frame per scene (recommended)"
          hint="One shot per scene, timed from the script. Fastest way to see the whole film."
        />
        <Option
          name={`${ids}-mode`}
          value="shots"
          checked={form.mode === 'shots'}
          onChange={() => set({ mode: 'shots' })}
          title="Break scenes into shots"
          hint="The AI splits each scene into several shots with types and camera notes."
        />
      </fieldset>

      <label className="flex items-start justify-between gap-3">
        <span className="flex flex-col">
          <span className="inline-flex items-center gap-1.5 text-body font-medium">
            <Link2 aria-hidden className="size-3.5 text-studio-accent-hover" />
            Chain scenes
          </span>
          <span className="text-small text-studio-muted">Each scene opens on the previous scene&apos;s last frame.</span>
        </span>
        <Switch checked={form.chain} onCheckedChange={(v) => set({ chain: v })} aria-label="Chain scenes" />
      </label>

      <fieldset className="flex flex-col gap-1">
        <legend className="section-label mb-1">Scenes</legend>
        <label className="flex items-center gap-2 text-body">
          <input type="radio" name={`${ids}-scope`} checked={form.scope === 'all'} onChange={() => set({ scope: 'all' })} />
          All scenes
        </label>
        <label className={cn('flex items-center gap-2 text-body', !selectedSceneId && 'opacity-50')}>
          <input
            type="radio"
            name={`${ids}-scope`}
            checked={form.scope === 'selected'}
            disabled={!selectedSceneId}
            onChange={() => set({ scope: 'selected' })}
          />
          Selected scene only{selectedSceneLabel ? `: ${selectedSceneLabel}` : ''}
        </label>
      </fieldset>

      <div className="flex flex-col gap-1.5">
        <label className="flex items-center gap-2 text-body">
          <input type="checkbox" checked={form.generateFrames} onChange={(e) => set({ generateFrames: e.target.checked })} />
          Generate frames now
        </label>
        <label className="flex items-center gap-2 text-body">
          <input type="checkbox" checked={form.includeExisting} onChange={(e) => set({ includeExisting: e.target.checked })} />
          Include scenes that already have shots
          {scenesWithShots > 0 && (
            <span className="text-small text-studio-muted">({plural(scenesWithShots, 'scene')} already storyboarded)</span>
          )}
        </label>
        {form.includeExisting && (
          <p className="text-small text-studio-muted">Shots you wrote or locked are never replaced; the AI suggests changes instead.</p>
        )}
      </div>

      <DialogFooter className="mt-0">
        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={pending}>
          <Wand2 aria-hidden />
          Storyboard {form.scope === 'selected' ? 'this scene' : 'all scenes'}
        </Button>
      </DialogFooter>
    </form>
  )
}
