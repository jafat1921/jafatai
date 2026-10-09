import { useState } from 'react'
import { Lightbulb, Palette, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { ErrorState } from '@/components/studio/states'
import { api } from '@/lib/api'
import { rangeFor } from '@/lib/photo/params'
import type { DevelopParams, PaletteEntry, RangeSpec } from '@/lib/photo/types'
import { DevelopSlider } from './DevelopSlider'
import { MAX_POINTS } from './LightPointsOverlay'

interface Props {
  params: DevelopParams
  ranges: Record<string, RangeSpec>
  photoId: string
  placing: boolean
  onPlacing: (on: boolean) => void
  selected: number | null
  onSelect: (i: number | null) => void
  onChange: (fn: (p: DevelopParams) => DevelopParams, group: string | null) => void
}

const FALLOFF = { min: 2, max: 80, step: 1, default: 25, label: 'Spread' }
const hex = (c: PaletteEntry) => c.hex ?? `rgb(${c.centerR} ${c.centerG} ${c.centerB})`

/** Local light pins (placed on the canvas) and Selective colour (the photo's own palette). */
export function LocalPanel({ params, ranges, photoId, placing, onPlacing, selected, onSelect, onChange }: Props) {
  const points = params.lightPoints ?? []
  const palette = params.palette ?? []
  const [open, setOpen] = useState<number | null>(null)
  const [finding, setFinding] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const pointRange = rangeFor(ranges, 'lightPoints.exposure')

  const setPoint = (i: number, patch: object, group: string | null) =>
    onChange((p) => ({ ...p, lightPoints: (p.lightPoints ?? []).map((x, j) => (j === i ? { ...x, ...patch } : x)) }), group)
  const setCluster = (i: number, patch: Partial<PaletteEntry>, group: string | null) =>
    onChange((p) => ({ ...p, palette: (p.palette ?? []).map((x, j) => (j === i ? { ...x, ...patch } : x)) }), group)

  const findColours = async () => {
    setFinding(true)
    setError(null)
    try {
      const { clusters } = await api.photo.palette(photoId)
      onChange((p) => ({ ...p, palette: clusters.slice(0, 16) }), null)
    } catch (e) {
      setError(e)
    } finally {
      setFinding(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <section aria-labelledby="lp-title" className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <h4 id="lp-title" className="section-label">
            Local light
          </h4>
          <Button size="sm" variant={placing ? 'primary' : 'secondary'} aria-pressed={placing} onClick={() => onPlacing(!placing)} disabled={!placing && points.length >= MAX_POINTS}>
            <Lightbulb aria-hidden />
            {placing ? 'Done placing' : 'Place points'}
          </Button>
        </div>
        {points.length === 0 ? (
          <p className="text-small text-studio-muted">Brighten or darken one spot, like a face or a window. Turn on “Place points”, then click the picture.</p>
        ) : (
          <ol className="flex flex-col gap-2">
            {points.map((pt, i) => {
              const longEdge = Math.max(pt.refW ?? 1, pt.refH ?? 1)
              const spread = pt.falloff && pt.refW ? Math.round((pt.falloff / longEdge) * 100) : 25
              return (
                <li
                  key={i}
                  className={`flex flex-col gap-1.5 rounded-[6px] border p-2 ${selected === i ? 'border-studio-accent bg-studio-accent-soft' : 'border-studio-border'}`}
                  onFocus={() => onSelect(i)}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-small font-medium">Point {i + 1}</span>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`Remove light point ${i + 1}`}
                      onClick={() => {
                        onChange((p) => ({ ...p, lightPoints: (p.lightPoints ?? []).filter((_, j) => j !== i) }), null)
                        onSelect(null)
                      }}
                    >
                      <Trash2 aria-hidden />
                    </Button>
                  </div>
                  <DevelopSlider name={`lp${i}`} label={`Point ${i + 1} exposure`} value={pt.exposure} range={pointRange} onChange={(v, g) => setPoint(i, { exposure: v }, g)} spatial />
                  <DevelopSlider
                    name={`lpf${i}`}
                    label={`Point ${i + 1} spread %`}
                    value={spread}
                    range={FALLOFF}
                    onChange={(v, g) => setPoint(i, { falloff: Math.round((v / 100) * (pt.refW ? longEdge : 1000)) }, g)}
                  />
                </li>
              )
            })}
          </ol>
        )}
      </section>

      <section aria-labelledby="sc-title" className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <h4 id="sc-title" className="section-label">
            Selective colour
          </h4>
          {palette.length > 0 ? (
            <Button size="sm" variant="ghost" onClick={() => onChange((p) => ({ ...p, palette: [] }), null)}>
              <X aria-hidden />
              Clear
            </Button>
          ) : (
            <Button size="sm" variant="secondary" loading={finding} onClick={findColours}>
              <Palette aria-hidden />
              Find colours
            </Button>
          )}
        </div>
        {error != null && <ErrorState compact title="Couldn't read the colours" error={error} onRetry={findColours} />}
        {palette.length === 0 ? (
          <p className="text-small text-studio-muted">Pull the photo's main colours, then shift, mute or drop any of them. Shown exactly once the server preview lands.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {palette.map((c, i) => (
              <li key={i} className="flex flex-col gap-1.5 rounded-[6px] border border-studio-border p-1.5">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="flex flex-1 items-center gap-2 rounded-[4px] text-left text-small hover:bg-studio-panel-hover"
                    aria-expanded={open === i}
                    onClick={() => setOpen(open === i ? null : i)}
                  >
                    <span aria-hidden className="size-4 rounded-[3px] border border-studio-border-strong" style={{ background: hex(c) }} />
                    Colour {i + 1}
                    {c.coverage != null && <span className="text-studio-muted">{Math.round(c.coverage * 100)}%</span>}
                  </button>
                  <Switch checked={c.enabled} onCheckedChange={(on) => setCluster(i, { enabled: on }, null)} aria-label={`Keep colour ${i + 1}`} />
                </div>
                {open === i &&
                  (['h', 's', 'l'] as const).map((ch) => (
                    <DevelopSlider
                      key={ch}
                      name={`pal${i}${ch}`}
                      label={`Colour ${i + 1} ${{ h: 'hue', s: 'saturation', l: 'lightness' }[ch]}`}
                      value={c[ch]}
                      range={rangeFor(ranges, `hsl.${ch}`)}
                      onChange={(v, g) => setCluster(i, { [ch]: v }, g)}
                    />
                  ))}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
