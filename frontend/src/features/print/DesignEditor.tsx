import { useEffect, useId, useMemo, useState } from 'react'
import { Loader2, RotateCcw, Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Segmented } from '@/features/image/ads/Segmented'
import { usePatchDesign } from '@/hooks/usePrint'
import { DISPLAY_FONTS, FONT_PRESETS, LAYOUTS, printApi, type Decor, type DesignPatch, type DesignSpec, type DesignTexts, type PrintDesign, type PrintJob } from '@/lib/print'
import { announce } from '@/stores/ui'
import { PrintChecks } from './PrintChecks'

const SELECT = 'h-8 w-full rounded-[6px] border border-studio-border-strong bg-studio-raised px-2 text-body focus-visible:outline-2 focus-visible:outline-studio-accent'
const HEX = /^#[0-9a-fA-F]{6}$/
const DECOR = [
  { id: 'none', label: 'None' },
  { id: 'awning', label: 'Awning' },
  { id: 'frame', label: 'Frame' },
] as const
const HERO = [
  { id: 'name', label: 'The name' },
  { id: 'headline', label: 'The hero line' },
] as const
const TEXT_FIELDS: { key: keyof DesignTexts; label: string; long?: boolean }[] = [
  { key: 'name', label: 'Name' },
  { key: 'tagline', label: 'Tagline' },
  { key: 'headline', label: 'Hero line' },
  { key: 'cta', label: 'Button' },
  { key: 'hours', label: 'Opening hours' },
  { key: 'phone', label: 'Phone' },
  { key: 'address', label: 'Address' },
  { key: 'website', label: 'Website' },
]
const COLOURS = [
  { key: 'ground', label: 'Background' },
  { key: 'ink', label: 'Text' },
  { key: 'accent', label: 'Accent' },
] as const

type Edit = {
  texts: DesignTexts
  layout: string
  decor: Decor
  hero: 'name' | 'headline'
  caps: boolean
  font_preset: string
  display_font: string
  colours: { ground: string; ink: string; accent: string }
  logo: 'auto' | 'none'
  print_safe: boolean
}

const fromSpec = (s: DesignSpec, report: PrintDesign['report']): Edit => ({
  texts: { ...s.texts, offers: [...s.texts.offers] },
  layout: report.layout ?? s.layout,
  decor: s.decor,
  hero: s.hero,
  caps: s.caps,
  font_preset: s.font_preset,
  display_font: s.display_font ?? '',
  colours: {
    ground: s.colours.ground || report.colours?.ground || '#FFFFFF',
    ink: s.colours.ink || report.colours?.ink || '#1B1B1B',
    accent: s.colours.accent || report.colours?.accent || '#2E7D32',
  },
  logo: s.logo.position,
  print_safe: s.print_safe,
})

/** Only what changed, so an untouched field keeps following the concept. */
function patchOf(base: Edit, e: Edit): DesignPatch {
  const p: DesignPatch = {}
  const texts: Partial<DesignTexts> = {}
  for (const f of TEXT_FIELDS) if (e.texts[f.key] !== base.texts[f.key]) (texts as Record<string, string>)[f.key] = e.texts[f.key] as string
  if (e.texts.offers.join('\n') !== base.texts.offers.join('\n')) texts.offers = e.texts.offers
  if (Object.keys(texts).length) p.texts = texts
  if (e.layout !== base.layout) p.layout = e.layout
  if (e.decor !== base.decor) p.decor = e.decor
  if (e.hero !== base.hero) p.hero = e.hero
  if (e.caps !== base.caps) p.caps = e.caps
  if (e.font_preset !== base.font_preset) p.font_preset = e.font_preset
  if (e.display_font !== base.display_font) p.display_font = e.display_font
  const colours: DesignPatch['colours'] = {}
  for (const c of COLOURS) if (e.colours[c.key].toUpperCase() !== base.colours[c.key].toUpperCase() && HEX.test(e.colours[c.key])) colours[c.key] = e.colours[c.key]
  if (Object.keys(colours).length) p.colours = colours
  if (e.logo !== base.logo) p.logo = { position: e.logo }
  if (e.print_safe !== base.print_safe) p.print_safe = e.print_safe
  return p
}

export function DesignEditor({ job, design }: { job: PrintJob; design: PrintDesign }) {
  const uid = useId()
  const id = (s: string) => `${uid}-${s}`
  const spec = design.spec!
  const base = useMemo(() => fromSpec(spec, design.report), [spec, design.report])
  const [edit, setEdit] = useState<Edit>(base)
  const [overlay, setOverlay] = useState(true)
  const [preview, setPreview] = useState<string | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [previewError, setPreviewError] = useState('')
  const save = usePatchDesign(job.id)
  const patch = useMemo(() => patchOf(base, edit), [base, edit])
  const dirty = Object.keys(patch).length > 0
  // the logo-led layout only means something with a kit logo
  const layouts = LAYOUTS[job.size.family].filter((l) => l.id !== 'logo_hero' || job.brand_kit?.has_logo || edit.layout === l.id)
  const presets = job.brand_kit?.has_fonts ? [{ id: 'brand', label: 'Brand fonts' }, ...FONT_PRESETS] : FONT_PRESETS
  const rtl = spec.rtl

  // a fresh saved version (or another option picked) starts the form again from it
  const [seen, setSeen] = useState(base)
  if (seen !== base) {
    setSeen(base)
    setEdit(base)
  }

  useEffect(() => {
    // unchanged: the saved version is what shows, nothing to fetch
    if (!dirty) return
    let gone = false
    const t = window.setTimeout(() => {
      setPreviewing(true)
      printApi
        .preview(job.id, design.id, patch)
        .then((blob) => {
          if (gone) return
          setPreview(URL.createObjectURL(blob))
          setPreviewError('')
        })
        .catch((err: Error) => !gone && setPreviewError(err.message))
        .finally(() => !gone && setPreviewing(false))
    }, 450)
    return () => {
      gone = true
      window.clearTimeout(t)
    }
  }, [dirty, patch, job.id, design.id])
  // the old picture stays up until the new one is in, then its object URL goes
  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview)
  }, [preview])

  const setText = (k: keyof DesignTexts, v: string) => setEdit((e) => ({ ...e, texts: { ...e.texts, [k]: v } }))
  const boxes = design.report.boxes
  const shown = (dirty && preview) || design.image_url
  const ratio = `${job.size.px[0]} / ${job.size.px[1]}`

  const doSave = () =>
    save.mutate(
      { designId: design.id, ...patch },
      { onSuccess: () => announce(`Option ${design.n} saved. Its print files will be made again on the next download.`) },
    )

  return (
    <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-3">
        <figure className="flex min-w-0 flex-col gap-1">
          {/* the wrapper hugs the picture, so the trim and safe lines land on it whatever its shape */}
          <div className="relative mx-auto inline-block max-w-full self-center overflow-hidden rounded-[6px] bg-studio-raised shadow-card" style={shown ? undefined : { aspectRatio: ratio, width: 'min(100%, 320px)' }}>
            {shown && <img src={shown} alt={`Option ${design.n}, ${dirty ? 'with your changes' : 'as saved'}`} className="block h-auto max-h-[70vh] w-auto max-w-full" />}
            {overlay && boxes && (
              <>
                <span
                  aria-hidden
                  className={job.size.shape === 'round' ? 'pointer-events-none absolute rounded-full border-2 border-[#D02020]' : 'pointer-events-none absolute border-2 border-[#D02020]'}
                  style={{ left: `${boxes.trim[0] * 100}%`, top: `${boxes.trim[1] * 100}%`, right: `${(1 - boxes.trim[2]) * 100}%`, bottom: `${(1 - boxes.trim[3]) * 100}%` }}
                />
                <span
                  aria-hidden
                  className="pointer-events-none absolute border border-dashed border-[#2060D0]"
                  style={{ left: `${boxes.safe[0] * 100}%`, top: `${boxes.safe[1] * 100}%`, right: `${(1 - boxes.safe[2]) * 100}%`, bottom: `${(1 - boxes.safe[3]) * 100}%` }}
                />
              </>
            )}
            {dirty && previewing && <Loader2 aria-label="Updating the preview" className="absolute right-2 top-2 size-5 animate-spin text-studio-accent" />}
          </div>
          <figcaption className="text-center text-small text-studio-muted">{job.size.label}</figcaption>
          {dirty && previewError && (
            <p role="alert" className="text-small text-studio-danger">
              {previewError}
            </p>
          )}
        </figure>
        <PrintChecks
          report={design.report}
          overlay={overlay}
          onOverlay={setOverlay}
          printSafe={edit.print_safe}
          onPrintSafe={(v) => setEdit((e) => ({ ...e, print_safe: v }))}
          idBase={id('pc')}
        />
      </div>

      <form
        className="flex min-w-0 flex-col gap-3"
        aria-label={`Edit option ${design.n}`}
        onSubmit={(e) => {
          e.preventDefault()
          if (dirty) doSave()
        }}
      >
        <div className="grid min-w-0 gap-2 sm:grid-cols-2">
          {TEXT_FIELDS.map((f) => (
            <div key={f.key} className="flex min-w-0 flex-col gap-1">
              <Label htmlFor={id(f.key)}>{f.label}</Label>
              <Input id={id(f.key)} dir={rtl ? 'rtl' : 'auto'} lang={spec.language} value={edit.texts[f.key] as string} onChange={(e) => setText(f.key, e.target.value)} />
            </div>
          ))}
          <div className="flex min-w-0 flex-col gap-1 sm:col-span-2">
            <Label htmlFor={id('offers')}>Offers, one per line</Label>
            <Textarea
              id={id('offers')}
              dir={rtl ? 'rtl' : 'auto'}
              rows={3}
              value={edit.texts.offers.join('\n')}
              onChange={(e) => setEdit((x) => ({ ...x, texts: { ...x.texts, offers: e.target.value.split('\n').map((l) => l.trimStart()).slice(0, 12) } }))}
            />
          </div>
        </div>

        <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-1">
            <Label htmlFor={id('layout')}>Layout</Label>
            <select id={id('layout')} className={SELECT} value={edit.layout} onChange={(e) => setEdit((x) => ({ ...x, layout: e.target.value }))}>
              {layouts.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label}
                  {l.photo ? ' (needs a photo)' : ''}
                </option>
              ))}
            </select>
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            <Label htmlFor={id('font')}>Type</Label>
            <select id={id('font')} className={SELECT} value={edit.font_preset} onChange={(e) => setEdit((x) => ({ ...x, font_preset: e.target.value }))}>
              {presets.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            <Label htmlFor={id('display')}>Name type</Label>
            <select id={id('display')} className={SELECT} value={edit.display_font} onChange={(e) => setEdit((x) => ({ ...x, display_font: e.target.value }))}>
              {DISPLAY_FONTS.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            <span aria-hidden className="text-small font-medium">
              Biggest line
            </span>
            <Segmented label="Biggest line" options={HERO} value={edit.hero} onChange={(hero) => setEdit((x) => ({ ...x, hero }))} className="w-full" />
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            <span aria-hidden className="text-small font-medium">
              Decoration
            </span>
            <Segmented label="Decoration" options={DECOR} value={edit.decor} onChange={(decor) => setEdit((x) => ({ ...x, decor }))} className="w-full" />
          </div>
        </div>

        <fieldset className="flex min-w-0 flex-col gap-1.5">
          <legend className="mb-1 text-small font-medium">Colours</legend>
          <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-3">
            {COLOURS.map((c) => (
              <div key={c.key} className="flex min-w-0 items-center gap-2">
                <input
                  type="color"
                  aria-label={`${c.label} colour picker`}
                  value={HEX.test(edit.colours[c.key]) ? edit.colours[c.key] : '#000000'}
                  onChange={(e) => setEdit((x) => ({ ...x, colours: { ...x.colours, [c.key]: e.target.value.toUpperCase() } }))}
                  className="h-8 w-10 shrink-0 cursor-pointer rounded-[4px] border border-studio-border-strong bg-studio-raised"
                />
                <div className="flex min-w-0 flex-1 flex-col">
                  <Label htmlFor={id(`c-${c.key}`)} className="text-small">
                    {c.label}
                  </Label>
                  <Input
                    id={id(`c-${c.key}`)}
                    value={edit.colours[c.key]}
                    maxLength={7}
                    aria-invalid={!HEX.test(edit.colours[c.key]) || undefined}
                    onChange={(e) => setEdit((x) => ({ ...x, colours: { ...x.colours, [c.key]: e.target.value.trim() } }))}
                    className="h-7 font-mono text-small"
                  />
                </div>
              </div>
            ))}
          </div>
          <p className="text-small text-studio-muted">The text colour is darkened or lightened on its own until it reads.</p>
        </fieldset>

        <div className="flex flex-wrap gap-x-4 gap-y-1">
          <label className="flex min-h-6 items-center gap-1.5 text-body">
            <input type="checkbox" className="size-4 accent-studio-accent" checked={edit.caps} onChange={(e) => setEdit((x) => ({ ...x, caps: e.target.checked }))} />
            Name in capitals
          </label>
          {job.brand_kit && (
            <label className="flex min-h-6 items-center gap-1.5 text-body">
              <input type="checkbox" className="size-4 accent-studio-accent" checked={edit.logo !== 'none'} onChange={(e) => setEdit((x) => ({ ...x, logo: e.target.checked ? 'auto' : 'none' }))} />
              Show the logo
            </label>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" variant="primary" disabled={!dirty} loading={save.isPending}>
            <Save aria-hidden />
            Save this version
          </Button>
          <Button type="button" variant="ghost" disabled={!dirty} onClick={() => setEdit(base)}>
            <RotateCcw aria-hidden />
            Undo changes
          </Button>
          <span aria-live="polite" className="text-small text-studio-muted">
            {dirty ? 'The preview shows your changes; nothing is saved yet.' : ''}
          </span>
        </div>
        {save.isError && (
          <p role="alert" className="text-small text-studio-danger">
            {save.error.message}
          </p>
        )}
      </form>
    </div>
  )
}
