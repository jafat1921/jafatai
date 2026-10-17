import { useEffect, useId, useRef, useState } from 'react'
import { Download, Loader2, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { fileStem } from '@/lib/model3d'
import { cn } from '@/lib/utils'
import { announce } from '@/stores/ui'
import type { ExportFormat } from './exporters'
import type { Lighting, Viewer } from './viewer3d'

const LIGHTS: { id: Lighting; label: string }[] = [
  { id: 'studio', label: 'Studio' },
  { id: 'soft', label: 'Soft' },
  { id: 'sunset', label: 'Sunset' },
]

const EXPORTS: { format: ExportFormat; label: string; hint: string }[] = [
  { format: 'obj', label: 'OBJ', hint: 'Geometry for any 3D app' },
  { format: 'stl', label: 'STL', hint: 'For 3D printing, no colour' },
  { format: 'usdz', label: 'USDZ', hint: 'iPhone and iPad, with textures' },
]

type Backdrop = 'plain' | 'checker'
const STEP = Math.PI / 12 // 15° a key press

const reducedMotion = () => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** A GLB on an orbit stage, with lighting, backdrop, wireframe and downloads. three.js loads on first view. */
export function ModelViewer({ url, title, className }: { url: string; title: string; className?: string }) {
  const uid = useId()
  const host = useRef<HTMLDivElement>(null)
  const viewer = useRef<Viewer | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [lighting, setLighting] = useState<Lighting>('studio')
  const [backdrop, setBackdrop] = useState<Backdrop>('plain')
  const [wire, setWire] = useState(false)
  const [busy, setBusy] = useState<ExportFormat | null>(null)
  const stem = fileStem(title)

  useEffect(() => {
    let gone = false
    let made: Viewer | null = null
    // a new url means a new model: the page keys this component by item, so state starts at 'loading'
    import('./viewer3d')
      .then(({ createViewer }) => {
        if (gone || !host.current) return
        made = createViewer(host.current, { reducedMotion: reducedMotion() })
        viewer.current = made
        return made.load(url).then(() => !gone && setState('ready'))
      })
      .catch(() => !gone && setState('error'))
    return () => {
      gone = true
      made?.dispose()
      viewer.current = null
    }
  }, [url])

  // a fresh viewer starts on the defaults; carry the current choices over
  useEffect(() => {
    if (state !== 'ready') return
    viewer.current?.setLighting(lighting)
    viewer.current?.setWireframe(wire)
  }, [state, lighting, wire])

  const onKey = (e: React.KeyboardEvent) => {
    const v = viewer.current
    if (!v) return
    const moves: Record<string, () => void> = {
      ArrowLeft: () => v.rotate(-STEP, 0),
      ArrowRight: () => v.rotate(STEP, 0),
      ArrowUp: () => v.rotate(0, -STEP),
      ArrowDown: () => v.rotate(0, STEP),
      '+': () => v.zoom(0.85),
      '=': () => v.zoom(0.85),
      '-': () => v.zoom(1.18),
      '0': () => v.reset(),
    }
    const fn = moves[e.key]
    if (!fn) return
    e.preventDefault()
    fn()
  }

  const download = async (format: ExportFormat) => {
    const model = viewer.current?.model()
    if (!model) return
    setBusy(format)
    try {
      const { exportModel } = await import('./exporters')
      saveBlob(await exportModel(model, format), `${stem}.${format}`)
      announce(`${format.toUpperCase()} file ready.`)
    } catch {
      announce(`Couldn't make the ${format.toUpperCase()} file.`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <section aria-labelledby={`${uid}-title`} className={cn('flex flex-col gap-3', className)}>
      <h2 id={`${uid}-title`} className="sr-only">
        {title}
      </h2>
      <div
        ref={host}
        tabIndex={0}
        role="application"
        aria-roledescription="3D viewer"
        aria-label={`${title}. Drag to turn it, scroll to zoom. Arrow keys turn it, plus and minus zoom, 0 resets.`}
        aria-busy={state === 'loading'}
        onKeyDown={onKey}
        className={cn(
          'relative aspect-square max-h-[70vh] w-full overflow-hidden rounded-[8px] border border-studio-border-strong sm:aspect-[4/3]',
          backdrop === 'checker' ? 'checker' : 'bg-studio-raised paper-fine',
        )}
      >
        {state === 'loading' && (
          <p className="absolute inset-0 flex items-center justify-center gap-2 text-small text-studio-muted">
            <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />
            Loading the model…
          </p>
        )}
        {state === 'error' && (
          <p role="alert" className="absolute inset-0 flex items-center justify-center p-4 text-center text-small text-studio-danger">
            This model couldn't be shown here. Your browser may not support 3D graphics; the GLB download still works.
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2" role="group" aria-label="View">
        <ToggleGroup type="single" aria-label="Lighting" value={lighting} onValueChange={(v) => v && setLighting(v as Lighting)}>
          {LIGHTS.map((l) => (
            <ToggleGroupItem key={l.id} value={l.id}>
              {l.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <ToggleGroup type="single" aria-label="Background" value={backdrop} onValueChange={(v) => v && setBackdrop(v as Backdrop)}>
          <ToggleGroupItem value="plain">Plain</ToggleGroupItem>
          <ToggleGroupItem value="checker">Checker</ToggleGroupItem>
        </ToggleGroup>
        <label htmlFor={`${uid}-wire`} className="inline-flex cursor-pointer items-center gap-2 text-body">
          <Switch id={`${uid}-wire`} checked={wire} onCheckedChange={setWire} disabled={state !== 'ready'} />
          Wireframe
        </label>
        <Button type="button" size="sm" variant="ghost" onClick={() => viewer.current?.reset()} disabled={state !== 'ready'}>
          <RotateCcw aria-hidden />
          Reset view
        </Button>
      </div>

      <div role="group" aria-label="Downloads" className="flex flex-wrap items-center gap-2">
        <Button asChild size="sm" variant="secondary">
          <a href={url} download={`${stem}.glb`}>
            <Download aria-hidden />
            GLB
          </a>
        </Button>
        {EXPORTS.map((x) => (
          <Button
            key={x.format}
            type="button"
            size="sm"
            variant="secondary"
            title={x.hint}
            aria-label={`Download ${x.label}: ${x.hint}`}
            disabled={state !== 'ready' || !!busy}
            loading={busy === x.format}
            onClick={() => download(x.format)}
          >
            <Download aria-hidden />
            {x.label}
          </Button>
        ))}
        <p className="text-small text-studio-muted">GLB is the original. OBJ, STL and USDZ are made in your browser.</p>
      </div>
    </section>
  )
}
