import { useId, useRef, useState } from 'react'
import { ChevronDown, LayoutTemplate, Wand2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Kbd } from '@/components/ui/kbd'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { ChipGroup } from '@/components/studio/chip'
import { PlaceholderHint } from '@/components/studio/placeholder-hint'
import { ErrorState } from '@/components/studio/states'
import { ModelPicker } from '@/components/models/ModelPicker'
import { SpeedPicker } from '@/components/models/SpeedPicker'
import { BrandChip } from '@/components/brand/BrandChip'
import { useBrandChoice } from '@/hooks/useBrandKits'
import { useImageGenerate } from '@/hooks/useMedia'
import { useModels } from '@/hooks/useModels'
import { useTemplates } from '@/hooks/useStudio'
import { IMAGE_STYLES, imagePayload, placeholdersIn, type ImageForm } from '@/lib/images'
import { modKey } from '@/lib/keyboard'
import { defaultSpeed, estimateSeconds, has, pickModel, secondsText } from '@/lib/models'
import { withBrand } from '@/lib/brand'
import { imageFormFrom } from '@/lib/templates'
import { cn, plural } from '@/lib/utils'
import { announce } from '@/stores/ui'
import { CountPicker, ImageAspectTiles } from './controls'

interface Props {
  initial: ImageForm
  templateTitle?: string
  modelPicked?: boolean
}

export function ImageGenerateForm({ initial, templateTitle, modelPicked }: Props) {
  const uid = useId()
  const field = useRef<HTMLTextAreaElement>(null)
  const [form, setForm] = useState<ImageForm>(initial)
  const [advanced, setAdvanced] = useState(!!(initial.negative || initial.seed || initial.steps))
  const [fromTemplate, setFromTemplate] = useState(templateTitle)
  const generate = useImageGenerate()
  const templates = useTemplates('image')
  const { models } = useModels('image')
  const brand = useBrandChoice()
  const set = <K extends keyof ImageForm>(k: K, v: ImageForm[K]) => setForm((f) => ({ ...f, [k]: v }))
  const model = pickModel(models, form.model)
  const speed = model?.speeds?.find((s) => s.id === form.speed && s.available !== false) ?? defaultSpeed(model)
  const perImage = estimateSeconds(model, speed?.id)

  const slots = placeholdersIn(form.prompt)
  const canSubmit = form.prompt.trim().length >= 3 && !slots.length && !generate.isPending

  const submit = () => {
    if (!canSubmit) return
    generate.mutate(withBrand(imagePayload({ ...form, model: model?.id, speed: speed?.id }), brand.sendId), {
      onSuccess: ({ items }) => announce(`Creating ${plural(items?.length ?? form.count, 'image')}. They appear below as they finish.`),
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
      className="flex flex-col gap-4 rounded-[8px] border border-studio-border-strong bg-studio-panel p-4 shadow-card"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Wand2 aria-hidden className="size-4 text-studio-accent-hover" />
        <h1 id={`${uid}-title`} className="font-display text-title font-semibold">
          Create Image
        </h1>
        {fromTemplate && (
          <span className="rounded-full border border-studio-gold/70 bg-studio-gold/10 px-2 text-small">Template: {fromTemplate}</span>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" size="sm" variant="ghost" className="ml-auto">
              <LayoutTemplate aria-hidden />
              Start from a template
              <ChevronDown aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-72">
            <DropdownMenuLabel>Image templates</DropdownMenuLabel>
            {templates.isPending && <p className="px-2 py-1.5 text-small text-studio-muted">Loading…</p>}
            {templates.isError && <p className="px-2 py-1.5 text-small text-studio-muted">Templates aren't available right now.</p>}
            {templates.data?.map((t) => (
              <DropdownMenuItem
                key={t.id}
                onSelect={() => {
                  setForm({ ...imageFormFrom(t.defaults ?? {}, t.id), model: form.model, speed: form.speed })
                  setFromTemplate(t.title)
                  announce(`Filled in from the ${t.title} template. Replace the highlighted words, then create.`)
                }}
              >
                <span className="flex flex-col">
                  <span>{t.title}</span>
                  <span className="text-small text-studio-muted">{t.description}</span>
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <ModelPicker label="Model" models={models} value={model?.id} onChange={(id) => setForm((f) => ({ ...f, model: id, speed: undefined }))} highlighted={modelPicked} />
      <BrandChip choice={brand} />
      {model?.speeds?.length ? <SpeedPicker model={model} value={speed?.id} onChange={(id) => set('speed', id)} /> : null}

      <div className="flex flex-col gap-2">
        <Label htmlFor={`${uid}-prompt`}>Describe the image</Label>
        <Textarea
          ref={field}
          id={`${uid}-prompt`}
          rows={3}
          maxLength={4000}
          value={form.prompt}
          onChange={(e) => set('prompt', e.target.value)}
          placeholder="e.g. A weathered lighthouse keeper in a wool coat, golden hour, 85mm portrait"
          // Urdu or Arabic prompts read right to left
          dir="auto"
          aria-describedby={has(model, 'text_render') ? `${uid}-texthint` : undefined}
          className="min-h-24 text-[15px] leading-6"
        />
        {has(model, 'text_render') && (
          <p id={`${uid}-texthint`} className="text-small text-studio-muted">
            Put text in quotes, e.g. a poster that says <bdi>{'"عید مبارک"'}</bdi>
          </p>
        )}
        <PlaceholderHint text={form.prompt} field={field} />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_auto]">
        <ImageAspectTiles value={form.aspect} onChange={(v) => v && set('aspect', v)} />
        <CountPicker value={form.count} onChange={(n) => set('count', n)} />
      </div>

      <ChipGroup label="Style" options={IMAGE_STYLES} value={form.style as (typeof IMAGE_STYLES)[number]['value'] | null} onChange={(v) => set('style', v)} />

      <div>
        <button
          type="button"
          aria-expanded={advanced}
          aria-controls={`${uid}-adv`}
          onClick={() => setAdvanced((a) => !a)}
          className="flex items-center gap-1.5 rounded-[6px] px-1 text-small text-studio-muted hover:text-studio-text"
        >
          <ChevronDown aria-hidden className={cn('size-3.5 transition-transform duration-150', advanced && 'rotate-180')} />
          Advanced
        </button>
        {advanced && (
          <div id={`${uid}-adv`} className="mt-2 grid gap-3 sm:grid-cols-[2fr_1fr_1fr]">
            <div>
              <Label htmlFor={`${uid}-neg`} className="mb-1.5">
                Avoid (negative prompt)
              </Label>
              <Input id={`${uid}-neg`} value={form.negative} onChange={(e) => set('negative', e.target.value)} placeholder="e.g. text, watermark, extra fingers" />
            </div>
            <div>
              <Label htmlFor={`${uid}-seed`} className="mb-1.5">
                Seed
              </Label>
              <Input id={`${uid}-seed`} inputMode="numeric" value={form.seed} onChange={(e) => set('seed', e.target.value.replace(/\D/g, ''))} placeholder="Random" className="font-mono" />
            </div>
            <div>
              <Label htmlFor={`${uid}-steps`} className="mb-1.5">
                Steps
              </Label>
              <Input id={`${uid}-steps`} inputMode="numeric" value={form.steps} onChange={(e) => set('steps', e.target.value.replace(/\D/g, ''))} placeholder="Default" className="font-mono" />
            </div>
          </div>
        )}
      </div>

      {generate.isError && <ErrorState compact title="Couldn't start the images" error={generate.error} />}

      <div className="flex flex-wrap items-center justify-end gap-3">
        <p className="mr-auto text-small text-studio-muted" aria-live="polite">
          {slots.length ? `Replace ${slots.join(', ')} first.` : `${plural(form.count, 'image')}${perImage ? ` · about ${secondsText(form.count * perImage)} on the GPU` : ''}`}
        </p>
        <Button type="submit" size="lg" variant="primary" disabled={!canSubmit} loading={generate.isPending} aria-keyshortcuts="Control+Enter">
          <Wand2 aria-hidden />
          Create
          <Kbd>{modKey}+Enter</Kbd>
        </Button>
      </div>
    </form>
  )
}
