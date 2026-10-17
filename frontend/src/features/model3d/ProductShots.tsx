import { useEffect, useId, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { Camera, Megaphone, Save } from 'lucide-react'
import { ErrorState } from '@/components/studio/states'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useProductShots } from '@/hooks/useModel3D'
import { adBriefHref, MAX_PRODUCTS } from '@/lib/ads'
import { cn } from '@/lib/utils'
import { announce } from '@/stores/ui'
import { SHOT_ANGLES, SHOT_SIZE, shotFile, type ShotAngle, type ShotBackground } from './shots'
import type { Viewer } from './viewer3d'

type Rendered = { angle: ShotAngle; label: string; blob: Blob; url: string }

const BACKGROUNDS: { id: ShotBackground; label: string }[] = [
  { id: 'white', label: 'White' },
  { id: 'paper', label: 'Paper' },
  { id: 'transparent', label: 'Transparent' },
]

const labelOf = (a: ShotAngle) => SHOT_ANGLES.find((s) => s.id === a)?.label ?? a

interface Props {
  viewer: () => Viewer | null
  mediaId: string
  title: string
  disabled: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  // the stage is drawn at 2048 while the angles render, so the viewer covers it
  onBusy: (busy: boolean) => void
}

/** "Product shots for adverts": clean renders of the model, ticked and saved as Ad Studio product photos. */
export function ProductShots({ viewer, mediaId, title, disabled, open, onOpenChange, onBusy }: Props) {
  const uid = useId()
  const nav = useNavigate()
  const panel = useRef<HTMLDivElement>(null)
  const [background, setBackground] = useState<ShotBackground>('white')
  const [shadow, setShadow] = useState(true)
  const [rendering, setRendering] = useState(false)
  const [renderError, setRenderError] = useState(false)
  const [shots, setShots] = useState<Rendered[]>([])
  const [keep, setKeep] = useState<ShotAngle[]>([])
  const [saved, setSaved] = useState<{ angle: ShotAngle; id: string }[] | null>(null)
  const [brief, setBrief] = useState<string[]>([])
  const save = useProductShots(mediaId)

  // object URLs live as long as their strip
  useEffect(() => () => shots.forEach((s) => URL.revokeObjectURL(s.url)), [shots])

  useEffect(() => {
    if (open) panel.current?.scrollIntoView?.({ block: 'nearest' })
  }, [open])

  const render = async () => {
    const v = viewer()
    if (!v || rendering) return
    setRendering(true)
    setRenderError(false)
    setSaved(null)
    save.reset()
    onBusy(true)
    announce(`Rendering ${SHOT_ANGLES.length} angles.`)
    try {
      const made = await v.shots(SHOT_ANGLES, { background, shadow: shadow && background !== 'transparent' })
      setShots(made.map((s) => ({ ...s, label: labelOf(s.angle), url: URL.createObjectURL(s.blob) })))
      setKeep(SHOT_ANGLES.filter((s) => s.keep && made.some((m) => m.angle === s.id)).map((s) => s.id))
      announce(`${made.length} angles ready. Untick any you don’t want, then save them.`)
    } catch {
      setRenderError(true)
      announce('Couldn’t render the angles.')
    } finally {
      setRendering(false)
      onBusy(false)
    }
  }

  const toggle = (a: ShotAngle) => setKeep((k) => (k.includes(a) ? k.filter((x) => x !== a) : [...k, a]))
  const kept = shots.filter((s) => keep.includes(s.angle))

  const upload = () => {
    if (!kept.length || save.isPending) return
    save.mutate(
      kept.map((s) => ({ file: shotFile(s.angle), blob: s.blob })),
      {
        onSuccess: (res) => {
          const rows = kept.map((s, i) => ({ angle: s.angle, id: res.ids[i] })).filter((r) => r.id)
          setSaved(rows)
          setBrief(rows.slice(0, MAX_PRODUCTS).map((r) => r.id))
          announce(`${rows.length} product shot${rows.length === 1 ? '' : 's'} saved for Ad Studio.`)
        },
        onError: () => announce('Couldn’t save the product shots.'),
      },
    )
  }

  const toggleBrief = (id: string) => setBrief((b) => (b.includes(id) ? b.filter((x) => x !== id) : b.length < MAX_PRODUCTS ? [...b, id] : b))
  const urlOf = (a: ShotAngle) => shots.find((s) => s.angle === a)?.url

  return (
    <div role="group" aria-label="Product shots for adverts" className="flex flex-col gap-2">
      <div>
        <Button type="button" size="sm" variant="secondary" aria-expanded={open} aria-controls={`${uid}-panel`} onClick={() => onOpenChange(!open)} disabled={disabled && !open}>
          <Camera aria-hidden />
          Product shots for adverts
        </Button>
      </div>
      {open && (
        <div ref={panel} id={`${uid}-panel`} className="flex min-w-0 flex-col gap-3 rounded-[8px] border border-studio-border bg-studio-raised p-3">
          <p id={`${uid}-hint`} className="text-small text-studio-muted">
            Clean angles of {title} at {SHOT_SIZE}×{SHOT_SIZE} under soft studio light, all framed alike, for Ad Studio’s product photos.
          </p>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <ToggleGroup type="single" aria-label="Shot background" value={background} onValueChange={(v) => v && setBackground(v as ShotBackground)} disabled={rendering}>
              {BACKGROUNDS.map((b) => (
                <ToggleGroupItem key={b.id} value={b.id}>
                  {b.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <label htmlFor={`${uid}-shadow`} className="inline-flex cursor-pointer items-center gap-2 text-body">
              <Switch id={`${uid}-shadow`} checked={shadow && background !== 'transparent'} onCheckedChange={setShadow} disabled={rendering || background === 'transparent'} />
              Soft shadow
            </label>
            <Button type="button" size="sm" variant="secondary" onClick={render} disabled={disabled || rendering} loading={rendering} aria-describedby={`${uid}-hint`}>
              <Camera aria-hidden />
              {rendering ? 'Rendering the angles…' : shots.length ? 'Render again' : 'Render angles'}
            </Button>
          </div>
          {renderError && (
            <p role="alert" className="text-small text-studio-danger">
              Couldn’t render the angles. Your browser may not manage pictures this large; try again, or try another browser.
            </p>
          )}

          {shots.length > 0 && !saved && (
            <fieldset className="flex min-w-0 flex-col gap-2">
              <legend className="mb-1 text-small font-medium">
                Angles to keep ({kept.length} of {shots.length})
              </legend>
              <ul className="grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-2">
                {shots.map((s) => {
                  const on = keep.includes(s.angle)
                  return (
                    <li key={s.angle}>
                      <label
                        htmlFor={`${uid}-k-${s.angle}`}
                        className={cn('flex cursor-pointer flex-col gap-1 rounded-[6px] border p-1.5 text-small', on ? 'border-studio-accent' : 'border-studio-border-strong opacity-80')}
                      >
                        <span className={cn('block aspect-square overflow-hidden rounded-[4px]', background === 'transparent' ? 'checker' : 'bg-studio-panel')}>
                          <img src={s.url} alt="" className="size-full object-contain" />
                        </span>
                        <span className="flex items-center gap-1.5">
                          <input id={`${uid}-k-${s.angle}`} type="checkbox" className="size-4 shrink-0 accent-studio-accent focus-visible:outline-2 focus-visible:outline-studio-accent" checked={on} onChange={() => toggle(s.angle)} />
                          <span className="min-w-0 truncate">{s.label}</span>
                        </span>
                      </label>
                    </li>
                  )
                })}
              </ul>
              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" size="sm" variant="primary" onClick={upload} disabled={!kept.length} loading={save.isPending}>
                  <Save aria-hidden />
                  {save.isPending ? 'Saving…' : `Save ${kept.length} for Ad Studio`}
                </Button>
                {!kept.length && <span className="text-small text-studio-muted">Tick at least one angle.</span>}
              </div>
            </fieldset>
          )}
          {save.isError && <ErrorState compact title="Couldn’t save the product shots" error={save.error} />}

          {saved && (
            <div className="flex min-w-0 flex-col gap-2">
              <p role="status" className="text-small">
                Saved. They wait in Ad Studio’s product photo picker, not in the Library.
              </p>
              {saved.length > MAX_PRODUCTS ? (
                <fieldset className="flex min-w-0 flex-col gap-2">
                  <legend className="mb-1 text-small font-medium">
                    For the brief, up to {MAX_PRODUCTS} ({brief.length} picked)
                  </legend>
                  <ul className="grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-2">
                    {saved.map((r) => {
                      const on = brief.includes(r.id)
                      const full = !on && brief.length >= MAX_PRODUCTS
                      return (
                        <li key={r.id}>
                          <label htmlFor={`${uid}-b-${r.id}`} className={cn('flex flex-col gap-1 rounded-[6px] border p-1.5 text-small', on ? 'border-studio-accent' : 'border-studio-border-strong', full ? 'cursor-not-allowed opacity-60' : 'cursor-pointer')}>
                            <span className={cn('block aspect-square overflow-hidden rounded-[4px]', background === 'transparent' ? 'checker' : 'bg-studio-panel')}>
                              <img src={urlOf(r.angle)} alt="" className="size-full object-contain" />
                            </span>
                            <span className="flex items-center gap-1.5">
                              <input
                                id={`${uid}-b-${r.id}`}
                                type="checkbox"
                                className="size-4 shrink-0 accent-studio-accent focus-visible:outline-2 focus-visible:outline-studio-accent"
                                checked={on}
                                disabled={full}
                                onChange={() => toggleBrief(r.id)}
                                aria-label={`Use ${labelOf(r.angle).toLowerCase()} in the brief`}
                              />
                              <span aria-hidden className="min-w-0 truncate">
                                {labelOf(r.angle)}
                              </span>
                            </span>
                          </label>
                        </li>
                      )
                    })}
                  </ul>
                </fieldset>
              ) : null}
              <div>
                <Button type="button" size="sm" variant="primary" disabled={!brief.length} onClick={() => nav(adBriefHref(brief))}>
                  <Megaphone aria-hidden />
                  Use in Ad Studio
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
