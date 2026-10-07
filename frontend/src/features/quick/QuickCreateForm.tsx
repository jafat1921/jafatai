import { useId, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { ChevronDown, Clapperboard, MessageSquareText, Wand2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { AspectTiles } from '@/components/studio/aspect-tile'
import { ChipGroup } from '@/components/studio/chip'
import { DurationFields } from '@/components/studio/duration-picker'
import { PlaceholderHint } from '@/components/studio/placeholder-hint'
import { SwitchRow } from '@/components/studio/switch-row'
import { QuickAdvanced } from './QuickAdvanced'
import { ErrorState } from '@/components/studio/states'
import { useCreateQuick } from '@/hooks/useQuick'
import { useUpscaleOptions } from '@/hooks/useUpscale'
import { formatDuration } from '@/lib/duration'
import { modKey } from '@/lib/keyboard'
import {
  DEFAULT_QUICK_FORM,
  QUICK_ASPECTS,
  QUICK_MAX_S,
  QUICK_MIN_S,
  QUICK_PRESETS,
  QUICK_STYLES,
  quickEstimateText,
  quickPayload,
  type QuickForm,
} from '@/lib/quick'
import type { QuickAspect, QuickStyle } from '@/lib/types'
import { placeholdersIn } from '@/lib/images'
import { pickEngine } from '@/lib/upscale'
import { cn } from '@/lib/utils'
import { announce } from '@/stores/ui'

/**
 * One prompt → finished video. On the Projects page the options start folded into a summary
 * line so the prompt box stays the obvious first step; /create shows everything.
 */
export function QuickCreateForm({
  expanded = false,
  className,
  initial,
  note,
}: {
  expanded?: boolean
  className?: string
  // from a template; still waits for the user to press Create
  initial?: Partial<QuickForm>
  note?: React.ReactNode
}) {
  const uid = useId()
  const field = useRef<HTMLTextAreaElement>(null)
  const navigate = useNavigate()
  const create = useCreateQuick()
  const options = useUpscaleOptions()
  const [form, setForm] = useState<QuickForm>({ ...DEFAULT_QUICK_FORM, ...initial })
  const [open, setOpen] = useState(expanded)
  const set = <K extends keyof QuickForm>(k: K, v: QuickForm[K]) => setForm((f) => ({ ...f, [k]: v }))

  const engines = options.data?.engines ?? []
  const engineId = pickEngine(engines, options.data?.default_engine)
  const engine = engines.find((e) => e.id === engineId)
  const upscaleHint = options.isError
    ? "Upscaling isn't available on this server yet."
    : options.data && !engine
      ? 'No upscale engine is installed on the server.'
      : `Adds a ${engine?.label ?? 'default engine'} pass at the end.`
  const slots = placeholdersIn(form.prompt)
  const canSubmit = form.prompt.trim().length >= 3 && !slots.length && !create.isPending
  const styleLabel = QUICK_STYLES.find((s) => s.value === form.style)?.label

  const submit = () => {
    if (!canSubmit) return
    create.mutate(quickPayload(form, engineId), {
      onSuccess: ({ project }) => {
        announce(`Started “${project.title}”. Writing the script.`)
        navigate(`/quick/${project.id}`)
      },
    })
  }

  return (
    <form
      aria-labelledby={`${uid}-title`}
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
      className={cn('flex flex-col gap-3 rounded-[8px] border border-studio-border-strong bg-studio-panel p-4 shadow-card', className)}
    >
      <div className="flex items-baseline gap-2">
        <Wand2 aria-hidden className="size-4 shrink-0 self-center text-studio-accent-hover" />
        <h2 id={`${uid}-title`} className="font-display text-title font-semibold">
          Quick Create
        </h2>
        <p className="text-small text-studio-muted max-sm:hidden">One prompt, a finished video. Open it in the studio later to refine.</p>
      </div>
      {note}

      <Label htmlFor={`${uid}-prompt`} className="sr-only">
        Describe your video
      </Label>
      <Textarea
        ref={field}
        id={`${uid}-prompt`}
        rows={3}
        value={form.prompt}
        maxLength={4000}
        onChange={(e) => set('prompt', e.target.value)}
        placeholder="Describe your video… e.g. A lighthouse keeper rescues a stray fox during a winter storm"
        className="min-h-24 text-[15px] leading-6"
      />
      <PlaceholderHint text={form.prompt} field={field} />

      {!expanded && (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={`${uid}-options`}
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-1.5 self-start rounded-[6px] px-1 text-small text-studio-muted hover:text-studio-text"
        >
          <ChevronDown aria-hidden className={cn('size-3.5 transition-transform duration-150', open && 'rotate-180')} />
          {open ? 'Hide options' : 'Options'}
          <span className="font-mono text-studio-text">
            {formatDuration(form.durationS)} · {form.aspect} · {styleLabel}
            {form.dialogue ? ' · narration' : ''}
            {form.upscale ? ' · 1080p' : ''}
            {form.videoQuality === 'hq' ? ' · high quality' : ''}
          </span>
        </button>
      )}

      {open && (
        <div id={`${uid}-options`} className="grid gap-4 md:grid-cols-2">
          <DurationFields
            label="Length"
            value={form.durationS}
            onChange={(v) => set('durationS', v)}
            presets={QUICK_PRESETS}
            min={QUICK_MIN_S}
            max={QUICK_MAX_S}
            limitNoun=""
            estimateLine={null}
          />
          <div>
            <div id={`${uid}-aspect`} className="section-label mb-2">
              Aspect
            </div>
            <AspectTiles value={form.aspect} onChange={(v) => set('aspect', v as QuickAspect)} labelledBy={`${uid}-aspect`} only={QUICK_ASPECTS} />
          </div>
          <ChipGroup
            label="Style"
            options={QUICK_STYLES}
            value={form.style}
            allowEmpty={false}
            onChange={(v) => v && set('style', v as QuickStyle)}
          />
          <div className="flex flex-col gap-2">
            <SwitchRow
              id={`${uid}-dialogue`}
              checked={form.dialogue}
              onChange={(v) => set('dialogue', v)}
              icon={<MessageSquareText aria-hidden className="size-3.5" />}
              title="Dialogue / narration"
              hint="Characters speak, or a narrator tells it. Off: music and ambience only."
            />
            <SwitchRow
              id={`${uid}-upscale`}
              checked={form.upscale && !!engine}
              disabled={!engine}
              onChange={(v) => set('upscale', v)}
              icon={<Clapperboard aria-hidden className="size-3.5" />}
              title="Upscale to 1080p when done"
              hint={upscaleHint}
            />
          </div>
          <QuickAdvanced form={form} onChange={(patch) => setForm((f) => ({ ...f, ...patch }))} />
        </div>
      )}

      {create.isError && <ErrorState compact title="Couldn't start the video" error={create.error} />}

      <div className="flex flex-wrap items-center justify-end gap-3">
        <p className="mr-auto text-small text-studio-muted" aria-live="polite">
          {slots.length
            ? `Replace ${slots.join(', ')} first.`
            : `${quickEstimateText(form.durationS, form.upscale ? engine : undefined)}. You can close the page while it works.`}
        </p>
        <Button type="submit" size="lg" variant="primary" disabled={!canSubmit} loading={create.isPending} aria-keyshortcuts="Control+Enter" className="max-sm:w-full">
          <Wand2 aria-hidden />
          Create video
          <Kbd>{modKey}+Enter</Kbd>
        </Button>
      </div>
    </form>
  )
}
