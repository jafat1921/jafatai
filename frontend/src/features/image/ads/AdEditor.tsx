import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { RotateCcw, Save, Shuffle, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { usePatchAd } from '@/hooks/useAds'
import {
  adsApi,
  COLOUR_ROLES,
  conceptFor,
  FONT_PRESETS,
  FOOTER_CONTACT,
  FORMATS,
  hexOrNull,
  LOGO_POSITIONS,
  MASK_LAYOUTS,
  MASK_SHAPES,
  patchFrom,
  styleLabel,
  type Ad,
  type AdCampaign,
  type AdReport,
  type AdSpec,
  type AdTexts,
  type ColourRole,
  type LogoPosition,
  type MaskShape,
} from '@/lib/ads'
import { announce } from '@/stores/ui'
import { FooterPicker } from './FooterPicker'
import { LayoutPicker } from './LayoutPicker'
import { Segmented } from './Segmented'

const SELECT = 'h-8 w-full rounded-[6px] border border-studio-border-strong bg-studio-raised px-2 text-body focus-visible:outline-2 focus-visible:outline-studio-accent'
const PREVIEW_DELAY = 400

const footerName = (key: string) => {
  if (key.startsWith('social')) return 'a social handle'
  if (key === 'follow') return 'the “Follow us” line'
  return FOOTER_CONTACT.find((f) => f.key === key)?.label.toLowerCase() ?? key
}

const SIDES = [
  { id: 'auto', label: 'Auto' },
  { id: 'swap', label: 'Swap' },
] as const
const SHAPE_FALLBACK = '#E8857B'

// older ads miss the newer spec keys (footer picks, the follow line, shapes, placement); fill them so the diff stays honest
function withDefaults(spec: AdSpec, keyWord?: string): AdSpec {
  return {
    ...spec,
    texts: { ...spec.texts, highlight: spec.texts.highlight ?? keyWord ?? '', quote: spec.texts.quote ?? '', quote_by: spec.texts.quote_by ?? '' },
    socials: spec.socials ?? [],
    follow: spec.follow ?? { show: false, text: '' },
    footer_items: spec.footer_items ?? { contact: Object.keys(spec.contact ?? {}) as AdSpec['footer_items']['contact'], socials: [] },
    shape: spec.shape ?? { mask: spec.style === 'circle_mask' ? 'circle' : 'arch', colour: '', seed: 0 },
    placement: spec.placement ?? { flip: null },
  }
}

// the server writes "big_price -> side_wash" (or close to it); anything else is shown as written
function fallbackText(f: string) {
  const m = /^\s*([a-z_]+)\s*(?:->|→|=>|>|:)\s*([a-z_]+)\s*$/i.exec(f)
  if (!m) return f
  return `${styleLabel(m[1])} couldn't be used for this ad, so it uses ${styleLabel(m[2])} instead.`
}

function Checks({ report }: { report: AdReport }) {
  const qa = report.quality?.qa
  const notes: string[] = []
  if (report.treatment?.includes('panel')) notes.push('A panel was added behind the copy so it stays readable on this photo.')
  if (report.fallback) notes.push(fallbackText(report.fallback))
  return (
    <>
      {qa?.flagged && (
        <p role="note" className="rounded-[6px] border border-studio-warning/50 bg-studio-warning/10 p-2 text-small">
          The final check flagged this ad{qa.issues.length ? `: ${qa.issues.join('; ')}` : '.'}
        </p>
      )}
      {notes.map((n) => (
        <p key={n} className="text-small text-studio-muted" role="note">
          {n}
        </p>
      ))}
    </>
  )
}

function ShapeColour({ id, value, onChange }: { id: string; value: string; onChange: (hex: string) => void }) {
  const [typed, setTyped] = useState(value)
  const [seen, setSeen] = useState(value)
  // the native picker or an undo changed it: show that, unless it's what is already typed
  if (seen !== value) {
    setSeen(value)
    if (hexOrNull(typed) !== value) setTyped(value)
  }
  const bad = !!typed.trim() && !hexOrNull(typed)
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-small font-medium">
        Shape colour
      </label>
      <div className="flex items-center gap-1.5">
        <input
          type="color"
          aria-label="Pick the shape colour"
          value={(hexOrNull(value) ?? SHAPE_FALLBACK).toLowerCase()}
          onChange={(e) => onChange(hexOrNull(e.target.value) ?? SHAPE_FALLBACK)}
          className="h-8 w-10 shrink-0 cursor-pointer rounded-[6px] border border-studio-border-strong bg-transparent focus-visible:outline-2 focus-visible:outline-studio-accent"
        />
        <Input
          id={id}
          dir="ltr"
          maxLength={7}
          placeholder="Accent"
          value={typed}
          aria-invalid={bad || undefined}
          aria-describedby={bad ? `${id}-bad` : undefined}
          onChange={(e) => {
            setTyped(e.target.value)
            const hex = hexOrNull(e.target.value)
            if (hex) onChange(hex)
          }}
          className="w-28 font-mono"
        />
      </div>
      {bad && (
        <span id={`${id}-bad`} className="text-small text-studio-danger">
          Use a hex colour like #E8857B.
        </span>
      )}
    </div>
  )
}

/** One ad's side panel: change the words, layout, fonts, colours and logo; the picture follows as you type. */
export function AdEditor({ camp, ad, onClose }: { camp: AdCampaign; ad: Ad; onClose: () => void }) {
  const uid = useId()
  const id = (s: string) => `${uid}-${s}`
  const keyWord = conceptFor(camp, ad)?.key_word
  const base = useMemo(() => withDefaults(ad.spec as AdSpec, keyWord), [ad.spec, keyWord])
  const [edit, setEdit] = useState<AdSpec>(base)
  const [preview, setPreview] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const save = usePatchAd(camp.id)
  const lang = camp.language
  const changes = useMemo(() => patchFrom(base, edit), [base, edit])
  const dirty = Object.keys(changes).length > 0
  const urlRef = useRef<string | null>(null)

  useEffect(() => {
    if (!dirty) return
    let live = true
    const t = window.setTimeout(() => {
      adsApi
        .preview(camp.id, ad.id, changes)
        .then((blob) => {
          if (!live) return
          const url = URL.createObjectURL(blob)
          if (urlRef.current) URL.revokeObjectURL(urlRef.current)
          urlRef.current = url
          setPreview(url)
          setPreviewError(null)
        })
        .catch((e: Error) => live && setPreviewError(e.message))
    }, PREVIEW_DELAY)
    return () => {
      live = false
      window.clearTimeout(t)
    }
  }, [camp.id, ad.id, changes, dirty])

  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    },
    [],
  )

  const text = <K extends keyof AdTexts>(k: K, v: AdTexts[K]) => setEdit((e) => ({ ...e, texts: { ...e.texts, [k]: v } }))
  const colour = (role: ColourRole, v: string) => setEdit((e) => ({ ...e, colours: { ...e.colours, [role]: v || undefined } }))
  const shape = (v: Partial<NonNullable<AdSpec['shape']>>) => setEdit((e) => ({ ...e, shape: { ...e.shape!, ...v } }))
  const newSeed = () => {
    const cur = edit.shape?.seed ?? 0
    let seed = Math.floor(Math.random() * 10000)
    if (seed === cur) seed = (seed + 1) % 10000
    shape({ seed })
  }
  const masked = MASK_LAYOUTS.includes(edit.style)
  const palette = camp.brand_kit?.palette ?? []
  const presets = camp.brand_kit?.has_fonts ? [{ id: 'brand', label: 'Brand fonts' }, ...FONT_PRESETS] : FONT_PRESETS
  const fmt = FORMATS.find((f) => f.id === ad.format)
  const src = (dirty && preview) || ad.image_url || undefined

  const submit = () =>
    save.mutate(
      { adId: ad.id, ...changes },
      {
        onSuccess: (a) => {
          setPreview(null)
          announce(`${fmt?.label ?? ad.format} ad saved as version ${a.version}.`)
        },
      },
    )

  return (
    <aside aria-labelledby={id('h')} className="flex flex-col gap-3 rounded-[8px] border border-studio-border-strong bg-studio-panel p-3 shadow-card lg:sticky lg:top-3 lg:max-h-[calc(100vh-7rem)] lg:overflow-y-auto">
      <div className="flex items-center gap-2">
        <h2 id={id('h')} className="font-display text-panel font-semibold">
          Edit {fmt?.label ?? ad.format}
        </h2>
        <span className="text-small text-studio-muted" aria-live="polite">
          {save.isPending ? 'Saving…' : dirty ? 'Unsaved changes' : ad.version ? `Version ${ad.version}` : ''}
        </span>
        <Button type="button" size="icon-sm" variant="ghost" className="ml-auto" aria-label="Close the editor" onClick={onClose}>
          <X aria-hidden />
        </Button>
      </div>
      <figure className="overflow-hidden rounded-[6px] border border-studio-border bg-studio-raised">
        {src && <img src={src} alt={dirty ? 'Preview with your changes' : `The ${fmt?.label ?? ad.format} ad`} className="mx-auto max-h-[46vh] w-auto object-contain" />}
        {previewError && (
          <figcaption role="alert" className="p-2 text-small text-studio-danger">
            {previewError}
          </figcaption>
        )}
      </figure>

      <div className="flex flex-col gap-1">
        <label htmlFor={id('kicker')} className="text-small font-medium">
          Kicker
        </label>
        <Input id={id('kicker')} dir="auto" lang={lang} maxLength={300} value={edit.texts.kicker} onChange={(e) => text('kicker', e.target.value)} />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={id('headline')} className="text-small font-medium">
          Headline
        </label>
        <Textarea id={id('headline')} dir="auto" lang={lang} rows={2} maxLength={300} value={edit.texts.headline} onChange={(e) => text('headline', e.target.value)} />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={id('hl')} className="text-small font-medium">
          Key word
        </label>
        <div className="flex gap-1.5">
          <Input
            id={id('hl')}
            dir="auto"
            lang={lang}
            maxLength={60}
            value={edit.texts.highlight ?? ''}
            placeholder="No highlight"
            onChange={(e) => text('highlight', e.target.value)}
            aria-describedby={id('hl-hint')}
          />
          <Button type="button" size="sm" variant="ghost" className="h-8 shrink-0" disabled={!edit.texts.highlight} onClick={() => text('highlight', '')}>
            No highlight
          </Button>
        </div>
        <span id={id('hl-hint')} className="text-small text-studio-muted">
          A word or short phrase from the headline, set in the accent colour.
        </span>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={id('body')} className="text-small font-medium">
          Body
        </label>
        <Textarea id={id('body')} dir="auto" lang={lang} rows={2} maxLength={600} value={edit.texts.body} onChange={(e) => text('body', e.target.value)} />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={id('offers')} className="text-small font-medium">
          Offers, one per line
        </label>
        <Textarea
          id={id('offers')}
          dir="auto"
          lang={lang}
          rows={2}
          value={edit.texts.offers.join('\n')}
          onChange={(e) =>
            text(
              'offers',
              e.target.value
                .split('\n')
                .map((s) => s.replace(/\s+/g, ' '))
                .slice(0, 3),
            )
          }
        />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="flex flex-col gap-1">
          <label htmlFor={id('cta')} className="text-small font-medium">
            Button
          </label>
          <Input id={id('cta')} dir="auto" lang={lang} maxLength={60} value={edit.texts.cta} onChange={(e) => text('cta', e.target.value)} />
        </div>
        {edit.style === 'badge' && (
          <div className="flex flex-col gap-1">
            <label htmlFor={id('badge')} className="text-small font-medium">
              Badge
            </label>
            <div className="flex gap-1">
              <Input id={id('badge')} dir="auto" maxLength={12} value={edit.texts.badge_big} onChange={(e) => text('badge_big', e.target.value)} aria-label="Badge, big text" />
              <Input dir="auto" maxLength={20} value={edit.texts.badge_small} onChange={(e) => text('badge_small', e.target.value)} aria-label="Badge, small text" />
            </div>
          </div>
        )}
      </div>

      {edit.style === 'quote' && (
        <div className="flex flex-col gap-2 rounded-[6px] border border-studio-border p-2">
          <div className="flex flex-col gap-1">
            <label htmlFor={id('quote')} className="text-small font-medium">
              Quote
            </label>
            <Textarea id={id('quote')} dir="auto" lang={lang} rows={2} maxLength={300} value={edit.texts.quote ?? ''} onChange={(e) => text('quote', e.target.value)} />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={id('quote-by')} className="text-small font-medium">
              Who said it
            </label>
            <Input id={id('quote-by')} dir="auto" lang={lang} maxLength={80} value={edit.texts.quote_by ?? ''} onChange={(e) => text('quote_by', e.target.value)} />
          </div>
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <span aria-hidden className="text-small font-medium">
          Layout
        </span>
        <LayoutPicker label="Layout" value={edit.style} onChange={(v) => setEdit((o) => ({ ...o, style: v }))} />
      </div>

      <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
        <div className="flex flex-col gap-1">
          <span aria-hidden className="text-small font-medium">
            Copy side
          </span>
          <Segmented
            label="Copy side"
            options={SIDES}
            value={edit.placement?.flip ? 'swap' : 'auto'}
            onChange={(v) => setEdit((o) => ({ ...o, placement: { flip: v === 'swap' ? true : null } }))}
            describedBy={id('side-hint')}
          />
        </div>
        {masked && (
          <div className="flex flex-col gap-1">
            <span aria-hidden className="text-small font-medium">
              Mask shape
            </span>
            <Segmented<MaskShape> label="Mask shape" options={MASK_SHAPES} value={edit.shape?.mask ?? 'arch'} onChange={(v) => shape({ mask: v })} />
          </div>
        )}
        <span id={id('side-hint')} className="basis-full text-small text-studio-muted">
          Auto keeps the copy clear of the person or product; Swap puts it on the other side.
        </span>
      </div>

      {edit.style === 'cutout_blob' && (
        <div className="flex flex-wrap items-end gap-2">
          <ShapeColour id={id('shape-c')} value={edit.shape?.colour ?? ''} onChange={(hex) => shape({ colour: hex })} />
          <Button type="button" size="sm" variant="secondary" className="h-8" onClick={newSeed}>
            <Shuffle aria-hidden />
            New shape
          </Button>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <div className="flex flex-col gap-1">
          <label htmlFor={id('font')} className="text-small font-medium">
            Fonts
          </label>
          <select id={id('font')} className={SELECT} value={edit.font_preset} onChange={(e) => setEdit((o) => ({ ...o, font_preset: e.target.value }))}>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={id('logo')} className="text-small font-medium">
            Logo
          </label>
          <select
            id={id('logo')}
            className={SELECT}
            value={edit.logo.position}
            onChange={(e) => setEdit((o) => ({ ...o, logo: { ...o.logo, position: e.target.value as LogoPosition } }))}
          >
            {LOGO_POSITIONS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        <label className="flex items-end gap-2 pb-1 text-small">
          <Switch checked={edit.footer} onCheckedChange={(v) => setEdit((o) => ({ ...o, footer: v }))} aria-label="Contact footer" />
          Contact footer
        </label>
      </div>

      {edit.footer && (
        <div className="flex flex-col gap-2 rounded-[6px] border border-studio-border p-2">
          <FooterPicker kit={camp.brand_kit} value={edit.footer_items} onChange={(v) => setEdit((o) => ({ ...o, footer_items: v }))} />
          {(camp.brand_kit?.socials?.length ?? 0) > 0 && (
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex items-center gap-2 pb-1 text-small">
                <Switch
                  checked={edit.follow.show}
                  disabled={!edit.footer_items.socials.length}
                  onCheckedChange={(v) => setEdit((o) => ({ ...o, follow: { ...o.follow, show: v } }))}
                  aria-label="“Follow us” line"
                />
                “Follow us” line
              </label>
              {edit.follow.show && (
                <div className="flex min-w-[10rem] flex-1 flex-col gap-1">
                  <label htmlFor={id('follow')} className="text-small text-studio-muted">
                    Its words (empty: “Follow us” in the ad's language)
                  </label>
                  <Input id={id('follow')} dir="auto" lang={lang} maxLength={40} value={edit.follow.text} onChange={(e) => setEdit((o) => ({ ...o, follow: { ...o.follow, text: e.target.value } }))} />
                </div>
              )}
            </div>
          )}
          {(ad.report.footer?.dropped.length ?? 0) > 0 && (
            <p className="text-small text-studio-muted" role="note">
              Left out to fit this format: {ad.report.footer?.dropped.map(footerName).join(', ')}.
            </p>
          )}
        </div>
      )}

      {palette.length > 0 && (
        <fieldset className="grid grid-cols-2 gap-2">
          <legend className="mb-1 text-small font-medium">Colours from your palette</legend>
          {COLOUR_ROLES.map((r) => (
            <div key={r.id} className="flex flex-col gap-1">
              <label htmlFor={id(`c-${r.id}`)} className="text-small text-studio-muted">
                {r.label}
              </label>
              <div className="flex items-center gap-1.5">
                <span aria-hidden className="size-5 shrink-0 rounded-[4px] border border-studio-border-strong" style={{ background: edit.colours[r.id] ?? 'transparent' }} />
                <select id={id(`c-${r.id}`)} className={SELECT} value={edit.colours[r.id] ?? ''} onChange={(e) => colour(r.id, e.target.value)}>
                  <option value="">Automatic</option>
                  {palette.map((p) => (
                    <option key={p.hex} value={p.hex}>
                      {p.name ? `${p.name} ${p.hex}` : p.hex}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          ))}
        </fieldset>
      )}

      <Checks report={ad.report} />

      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="primary" disabled={!dirty} loading={save.isPending} onClick={submit}>
          <Save aria-hidden />
          Save this ad
        </Button>
        <Button type="button" variant="ghost" disabled={!dirty} onClick={() => setEdit(base)}>
          <RotateCcw aria-hidden />
          Undo changes
        </Button>
        {Object.keys(ad.overrides ?? {}).length > 0 && !dirty && (
          <Button type="button" variant="ghost" loading={save.isPending} onClick={() => save.mutate({ adId: ad.id, reset: true })}>
            Back to the concept
          </Button>
        )}
      </div>
      {save.isError && (
        <p role="alert" className="text-small text-studio-danger">
          {save.error.message}
        </p>
      )}
    </aside>
  )
}
