import { useId, useState } from 'react'
import { ChevronDown, Loader2 } from 'lucide-react'
import { fieldClass, Input } from '@/components/ui/input'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { ErrorState } from '@/components/studio/states'
import { SwitchRow } from '@/components/studio/switch-row'
import { useBrandPreview } from '@/hooks/useBrandKits'
import type { BrandSettings, PreviewKind } from '@/lib/brand'
import { cn } from '@/lib/utils'

const KINDS: { value: PreviewKind; label: string }[] = [
  { value: 'image', label: 'Logo & grade' },
  { value: 'end_card', label: 'End card' },
  { value: 'intro_card', label: 'Intro card' },
  { value: 'lower_third', label: 'Lower third' },
]

const POSITIONS = [
  { value: 'tl', label: 'Top left' },
  { value: 'tr', label: 'Top right' },
  { value: 'bl', label: 'Bottom left' },
  { value: 'br', label: 'Bottom right' },
] as const

function Num({ label, value, onChange, min, max, step = 0.5, suffix }: { label: string; value: number; onChange: (v: number) => void; min: number; max: number; step?: number; suffix?: string }) {
  const id = useId()
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-small font-medium">
        {label}
      </label>
      <div className="flex items-center gap-1">
        <Input id={id} type="number" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Math.min(max, Math.max(min, Number(e.target.value) || min)))} className="w-20 font-mono" />
        {suffix && <span className="text-small text-studio-muted">{suffix}</span>}
      </div>
    </div>
  )
}

function Preview({ kitId, settings, kind }: { kitId: string; settings: BrandSettings; kind: PreviewKind }) {
  const p = useBrandPreview(kitId, kind, settings, true)
  return (
    <div className="darkroom relative flex aspect-video items-center justify-center overflow-hidden rounded-[6px]">
      {p.url ? <img src={p.url} alt={`Preview: ${KINDS.find((k) => k.value === kind)?.label}`} className="size-full object-contain" /> : null}
      {p.loading && (
        <span className="absolute right-2 top-2 inline-flex items-center gap-1 rounded bg-studio-darkroom/80 px-1.5 text-small text-studio-on-dark">
          <Loader2 aria-hidden className="size-3 animate-spin" />
          Updating
        </span>
      )}
      {p.error ? <ErrorState compact className="absolute inset-x-2 bottom-2" title="No preview" error={p.error} /> : null}
    </div>
  )
}

/** Watermark, cards, lower third, grade: exact composited extras, all off unless switched on. Collapsed by default. */
export function ExtrasSection({ kitId, settings, onChange }: { kitId: string; settings: BrandSettings; onChange: (s: BrandSettings) => void }) {
  const uid = useId()
  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState<PreviewKind>('image')
  const put = <K extends keyof BrandSettings>(k: K, patch: Partial<BrandSettings[K]>) => onChange({ ...settings, [k]: { ...(settings[k] as object), ...patch } })
  const on = (['watermark', 'end_card', 'intro_card', 'lower_third', 'grade'] as const).filter((k) => settings[k]?.enabled)

  return (
    <section aria-labelledby={`${uid}-h`} className="rounded-[8px] border border-studio-border-strong bg-studio-panel shadow-card">
      <h2 id={`${uid}-h`} className="m-0">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={`${uid}-body`}
          onClick={() => setOpen((o) => !o)}
          className="flex w-full items-center gap-2 rounded-[8px] p-4 text-left hover:bg-studio-panel-hover"
        >
          <ChevronDown aria-hidden className={cn('size-4 text-studio-muted transition-transform duration-150', open && 'rotate-180')} />
          <span className="font-display text-panel font-semibold">Optional extras</span>
          <span className="ml-auto text-small text-studio-muted">{on.length ? `${on.length} on` : 'All off'}</span>
        </button>
      </h2>
      {open && (
        <div id={`${uid}-body`} className="grid gap-4 px-4 pb-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="flex flex-col gap-3">
            <p className="text-small text-studio-muted">Exact overlays added after generation. Most adverts don't need them: the logo already appears in the scenes.</p>
            <SwitchRow id={`${uid}-wm`} checked={settings.watermark.enabled} onChange={(v) => put('watermark', { enabled: v })} title="Watermark" hint="Your logo in a corner of every output." />
            {settings.watermark.enabled && (
              <div className="flex flex-wrap gap-3 pl-2">
                <div className="flex flex-col gap-1">
                  <label htmlFor={`${uid}-pos`} className="text-small font-medium">
                    Corner
                  </label>
                  <select id={`${uid}-pos`} value={settings.watermark.position} onChange={(e) => put('watermark', { position: e.target.value as BrandSettings['watermark']['position'] })} className={cn(fieldClass, 'h-8 w-36')}>
                    {POSITIONS.map((p) => (
                      <option key={p.value} value={p.value}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </div>
                <Num label="Size" value={settings.watermark.size_pct} min={2} max={50} step={1} suffix="%" onChange={(v) => put('watermark', { size_pct: v })} />
                <Num label="Opacity" value={Math.round(settings.watermark.opacity * 100)} min={5} max={100} step={5} suffix="%" onChange={(v) => put('watermark', { opacity: v / 100 })} />
              </div>
            )}
            <SwitchRow id={`${uid}-end`} checked={settings.end_card.enabled} onChange={(v) => put('end_card', { enabled: v })} title="End card" hint="Logo and tagline on a brand colour after videos." />
            {settings.end_card.enabled && (
              <div className="pl-2">
                <Num label="Length" value={settings.end_card.duration_s} min={1} max={8} suffix="s" onChange={(v) => put('end_card', { duration_s: v })} />
              </div>
            )}
            <SwitchRow id={`${uid}-intro`} checked={settings.intro_card.enabled} onChange={(v) => put('intro_card', { enabled: v })} title="Intro card" hint="The same card before videos." />
            {settings.intro_card.enabled && (
              <div className="pl-2">
                <Num label="Length" value={settings.intro_card.duration_s} min={1} max={8} suffix="s" onChange={(v) => put('intro_card', { duration_s: v })} />
              </div>
            )}
            <SwitchRow id={`${uid}-lt`} checked={settings.lower_third.enabled} onChange={(v) => put('lower_third', { enabled: v })} title="Lower third" hint="Name and tagline that fade in near the start." />
            {settings.lower_third.enabled && (
              <div className="grid gap-2 pl-2 sm:grid-cols-2">
                <Input dir="auto" aria-label="Lower third text" placeholder="Text (default: kit name)" value={settings.lower_third.text ?? ''} onChange={(e) => put('lower_third', { text: e.target.value || null })} />
                <Input dir="auto" aria-label="Lower third subtext" placeholder="Subtext (default: tagline)" value={settings.lower_third.subtext ?? ''} onChange={(e) => put('lower_third', { subtext: e.target.value || null })} />
              </div>
            )}
            <SwitchRow id={`${uid}-grade`} checked={settings.grade.enabled} onChange={(v) => put('grade', { enabled: v })} title="Colour grade" hint="A gentle push toward your palette." />
            {settings.grade.enabled && (
              <div className="pl-2">
                <Num label="Strength" value={Math.round(settings.grade.strength * 100)} min={0} max={100} step={5} suffix="%" onChange={(v) => put('grade', { strength: v / 100 })} />
              </div>
            )}
          </div>
          <div className="flex flex-col gap-2">
            <ToggleGroup type="single" aria-label="Preview" value={kind} onValueChange={(v) => v && setKind(v as PreviewKind)} className="flex-wrap">
              {KINDS.map((k) => (
                <ToggleGroupItem key={k.value} value={k.value} className="px-2">
                  {k.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <Preview kitId={kitId} settings={settings} kind={kind} />
            <p className="text-small text-studio-muted">Shows your unsaved changes. The logo preview marks the corner even while the watermark is off.</p>
          </div>
        </div>
      )}
    </section>
  )
}
