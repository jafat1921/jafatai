import { useEffect, useEffectEvent, useId, useRef, useState } from 'react'
import { Link } from 'react-router'
import { Download, Film, ImageIcon, Loader2, RotateCcw, X } from 'lucide-react'
import { ErrorState } from '@/components/studio/states'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useModelThumbnail, useTurntable } from '@/hooks/useModel3D'
import { useFeature } from '@/hooks/useUsage'
import { fileStem, saveBlob } from '@/lib/model3d'
import type { MediaItem } from '@/lib/types'
import { cn } from '@/lib/utils'
import { announce } from '@/stores/ui'
import type { ExportFormat } from './exporters'
import { ProductShots } from './ProductShots'
import { canRecord, TURNTABLE } from './turntable'
import type { Backdrop, Facing, Lighting, Viewer } from './viewer3d'

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

const STEP = Math.PI / 12 // 15° a key press
const NO_RECORDER = 'This browser can’t record video, so there’s no turntable here. Chrome, Edge and Firefox can.'

const reducedMotion = () => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

/** A GLB on an orbit stage, with lighting, backdrop, wireframe and downloads. three.js loads on first view.
 * Given the model's mediaId it also records a turntable and sets the Library thumbnail. Lighting, backdrop and
 * wireframe stay as they are when the url changes to another model; the facing starts at Front for each. */
export type ViewerAsk = { n: number; action: 'turntable' | 'thumbnail' | 'shots' }

interface Props {
  url: string
  title: string
  mediaId?: string
  // an action picked from a tile's menu, run once this model is drawn
  ask?: ViewerAsk | null
  onAsked?: () => void
  className?: string
}

export function ModelViewer({ url, title, mediaId, ask, onAsked, className }: Props) {
  const uid = useId()
  const host = useRef<HTMLDivElement>(null)
  const viewer = useRef<Viewer | null>(null)
  // per url, so moving to another model is 'loading' again without a reset in an effect
  const [loaded, setLoaded] = useState<{ url: string; ok: boolean } | null>(null)
  const state = loaded?.url !== url ? 'loading' : loaded.ok ? 'ready' : 'error'
  const [lighting, setLighting] = useState<Lighting>('studio')
  const [backdrop, setBackdrop] = useState<Backdrop>('plain')
  const [wire, setWire] = useState(false)
  const [turned, setTurned] = useState<{ url: string; facing: Facing } | null>(null)
  const facing: Facing = turned?.url === url ? turned.facing : 'front'
  const [busy, setBusy] = useState<ExportFormat | null>(null)
  const [recording, setRecording] = useState<number | null>(null) // percent, while the turn is recorded
  const [note, setNote] = useState<{ url: string; text: string } | null>(null)
  const recordNote = note?.url === url ? note.text : null
  const setRecordNote = (text: string | null) => setNote(text ? { url, text } : null)
  const [savedFor, setSaved] = useState<{ url: string; item: MediaItem } | null>(null)
  const saved = savedFor?.url === url ? savedFor.item : null
  const abort = useRef<AbortController | null>(null)
  const turntable = useTurntable(mediaId ?? '')
  const thumb = useModelThumbnail(mediaId ?? '')
  const stem = fileStem(title)
  // product shots go to Ad Studio, so the package needs both studios
  const on3d = useFeature('3d')
  const onAds = useFeature('ads')
  const shotsOn = on3d && onAds
  const [shotsOpen, setShotsOpen] = useState(false)
  // per url like the rest, so a render cut short by moving to another model doesn't leave the stage covered
  const [shootingFor, setShootingFor] = useState<string | null>(null)
  const shooting = shootingFor === url

  useEffect(() => {
    let gone = false
    let made: Viewer | null = null
    import('./viewer3d')
      .then(({ createViewer }) => {
        if (gone || !host.current) return
        made = createViewer(host.current, { reducedMotion: reducedMotion() })
        viewer.current = made
        return made.load(url).then(() => !gone && setLoaded({ url, ok: true }))
      })
      .catch(() => !gone && setLoaded({ url, ok: false }))
    return () => {
      gone = true
      abort.current?.abort()
      made?.dispose()
      viewer.current = null
    }
  }, [url])

  // each model gets a fresh viewer on the defaults; once it's drawn, carry the current choices over
  useEffect(() => {
    if (state !== 'ready') return
    viewer.current?.setLighting(lighting)
    viewer.current?.setWireframe(wire)
    viewer.current?.setFacing(facing)
  }, [state, lighting, wire, facing])

  // the switch shows what the viewer did, not just what was asked
  const toggleWire = (on: boolean) => {
    const v = viewer.current
    if (!v) return
    v.setWireframe(on)
    setWire(v.wireframe())
  }

  const onKey = (e: React.KeyboardEvent) => {
    const v = viewer.current
    if (!v || recording != null || shooting) return
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

  const makeTurntable = async () => {
    const v = viewer.current
    if (!v || recording != null || turntable.isPending) return
    setSaved(null)
    turntable.reset()
    if (!canRecord()) {
      setRecordNote(NO_RECORDER)
      return
    }
    setRecordNote(null)
    const ctl = new AbortController()
    abort.current = ctl
    setRecording(0)
    announce(`Recording the turntable. It takes about ${TURNTABLE.seconds} seconds.`)
    let video: Blob
    try {
      // whole fives, so React isn't re-rendering at the frame rate
      video = await v.turntable(backdrop, { signal: ctl.signal, onProgress: (share) => setRecording(Math.floor(share * 20) * 5) })
    } catch (e) {
      const cancelled = (e as Error)?.name === 'AbortError'
      setRecording(null)
      setRecordNote(cancelled ? null : 'Couldn’t record the turntable. Try again, or try another browser.')
      announce(cancelled ? 'Turntable cancelled.' : 'Couldn’t record the turntable.')
      return
    } finally {
      abort.current = null
    }
    setRecording(null)
    announce('Recorded. Saving the turntable to the Library.')
    turntable.mutate(video, {
      onSuccess: (res) => {
        setSaved({ url, item: res.item })
        announce('Turntable saved to the Library.')
      },
      onError: () => announce('Couldn’t save the turntable.'),
    })
  }

  const takeThumbnail = async () => {
    const v = viewer.current
    if (!v || thumb.isPending) return
    let picture: Blob
    try {
      picture = await v.snapshot()
    } catch {
      announce('Couldn’t take a picture of this view.')
      return
    }
    thumb.mutate(picture, {
      onSuccess: () => announce('Thumbnail set. The Library shows this view now.'),
      onError: () => announce('Couldn’t set the thumbnail.'),
    })
  }

  const still = state !== 'ready' || recording != null || shooting

  const runAsk = useEffectEvent((a: ViewerAsk) => {
    onAsked?.()
    if (a.action === 'shots') setShotsOpen(true)
    else void (a.action === 'turntable' ? makeTurntable() : takeThumbnail())
  })
  useEffect(() => {
    if (state !== 'ready' || !ask) return
    // after this render, so the viewer's state updates aren't made inside the effect
    const t = setTimeout(() => runAsk(ask), 0)
    return () => clearTimeout(t)
  }, [state, ask])

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
        {recording != null && (
          // opaque on purpose: the stage is drawn square while it records, and nothing spins on screen
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-studio-raised p-4 paper-fine">
            <p id={`${uid}-rec`} className="text-body">
              Recording the turntable… {recording}%
            </p>
            <div
              role="progressbar"
              aria-labelledby={`${uid}-rec`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={recording}
              className="h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-studio-border"
            >
              <div className="h-full bg-studio-accent" style={{ width: `${recording}%` }} />
            </div>
            <Button type="button" size="sm" variant="secondary" onClick={() => abort.current?.abort()}>
              <X aria-hidden />
              Cancel
            </Button>
          </div>
        )}
        {shooting && (
          <p className="absolute inset-0 flex items-center justify-center gap-2 bg-studio-raised p-4 text-small text-studio-muted paper-fine">
            <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />
            Rendering the product shots…
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
          <Switch id={`${uid}-wire`} checked={wire} onCheckedChange={toggleWire} disabled={still} />
          Wireframe
        </label>
        <ToggleGroup
          type="single"
          aria-label="Facing"
          aria-describedby={`${uid}-face`}
          value={facing}
          onValueChange={(v) => v && setTurned({ url, facing: v as Facing })}
          disabled={still}
        >
          <ToggleGroupItem value="front">Front</ToggleGroupItem>
          <ToggleGroupItem value="back">Back</ToggleGroupItem>
        </ToggleGroup>
        <span id={`${uid}-face`} className="sr-only">
          Turns the model round if it opens facing away. Downloads and the turntable follow.
        </span>
        <Button type="button" size="sm" variant="ghost" onClick={() => viewer.current?.reset()} disabled={still}>
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

      {mediaId && (
        <div role="group" aria-label="Turntable and thumbnail" className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" variant="secondary" onClick={makeTurntable} disabled={still} loading={turntable.isPending} aria-describedby={`${uid}-tt`}>
              <Film aria-hidden />
              {turntable.isPending ? 'Saving the turntable…' : 'Make turntable'}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={takeThumbnail} disabled={still} loading={thumb.isPending}>
              <ImageIcon aria-hidden />
              Use this view as thumbnail
            </Button>
          </div>
          <p id={`${uid}-tt`} className="text-small text-studio-muted">
            A {TURNTABLE.seconds}-second turn at {TURNTABLE.size}×{TURNTABLE.size}, with this lighting and background, saved to the Library as a video.
          </p>
          {recordNote && (
            <p role="status" className="text-small text-studio-warning">
              {recordNote}
            </p>
          )}
          {turntable.isError && <ErrorState compact title="Couldn’t save the turntable" error={turntable.error} />}
          {thumb.isError && <ErrorState compact title="Couldn’t set the thumbnail" error={thumb.error} />}
          {saved?.media_url && (
            <div className="flex flex-wrap items-end gap-3">
              <video
                src={saved.media_url}
                controls
                loop
                muted
                playsInline
                autoPlay={!reducedMotion()}
                aria-label={`${title}, turntable`}
                className="w-40 rounded-[6px] border border-studio-border-strong"
              />
              <p className="text-small">
                Saved to the Library.{' '}
                <Link to="/video/library" className="underline">
                  Open the video library
                </Link>
              </p>
            </div>
          )}
        </div>
      )}
      {mediaId && shotsOn && (
        <ProductShots
          key={url}
          viewer={() => viewer.current}
          mediaId={mediaId}
          title={title}
          disabled={still}
          open={shotsOpen}
          onOpenChange={setShotsOpen}
          onBusy={(busy) => setShootingFor(busy ? url : null)}
        />
      )}
    </section>
  )
}
