import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent as RPointerEvent } from 'react'
import { Pause, Play, Search } from 'lucide-react'
import { Kbd } from '@/components/ui/kbd'
import { containedRect } from '@/lib/media'
import { cn } from '@/lib/utils'

const LOUPE = 168
const clamp = (v: number) => Math.max(0, Math.min(100, v))

interface Props {
  before: string
  after: string
  alt: string
  beforeLabel?: string
  afterLabel?: string
  kind?: 'image' | 'video'
  // e.g. "aspect-[4/3]"; leave out to fill a sized parent
  aspectClass?: string
  className?: string
  // L works anywhere on the page, not only with focus inside (the lightbox wants this)
  globalLoupeKey?: boolean
}

/**
 * Before/after wipe. Drag the divider (mouse or touch), or focus it and use ←/→ (Shift for big
 * steps), Home and End. L toggles a 1:1 loupe that shows true pixels of whichever side is under it.
 * Videos play frame-locked: the "after" clip drives, the "before" one follows.
 */
export function BeforeAfter({ before, after, alt, beforeLabel = 'Before', afterLabel = 'After', kind = 'image', aspectClass, className, globalLoupeKey }: Props) {
  const uid = useId()
  const stage = useRef<HTMLDivElement>(null)
  const vids = useRef<{ before: HTMLVideoElement | null; after: HTMLVideoElement | null }>({ before: null, after: null })
  const [split, setSplit] = useState(50)
  const [dragging, setDragging] = useState(false)
  const [loupe, setLoupe] = useState(false)
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)
  // stage size and each picture's natural size, kept in state so the loupe renders from props and state only
  const [geo, setGeo] = useState<{ w: number; h: number } | null>(null)
  const [nat, setNat] = useState<Record<'before' | 'after', { w: number; h: number } | null>>({ before: null, after: null })
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState({ t: 0, d: 0 })
  const video = kind === 'video'

  const local = (e: { clientX: number; clientY: number }) => {
    const r = stage.current?.getBoundingClientRect()
    if (!r || !r.width) return null
    if (geo?.w !== r.width || geo?.h !== r.height) setGeo({ w: r.width, h: r.height })
    return { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, h: r.height }
  }
  const moveTo = (e: { clientX: number; clientY: number }) => {
    const p = local(e)
    if (p) setSplit(clamp((p.x / p.w) * 100))
  }

  const onPointerDown = (e: RPointerEvent<HTMLDivElement>) => {
    const onHandle = (e.target as HTMLElement).closest('[role="slider"]')
    if (loupe && !onHandle && !video) {
      // press-and-hold shows the loupe on touch screens
      const p = local(e)
      if (p) setAt({ x: p.x, y: p.y })
      return
    }
    if ((e.target as HTMLElement).closest('button')) return
    e.currentTarget.setPointerCapture?.(e.pointerId)
    setDragging(true)
    moveTo(e)
  }
  const onPointerMove = (e: RPointerEvent<HTMLDivElement>) => {
    if (dragging) return moveTo(e)
    if (loupe && !video && (e.pointerType === 'mouse' || e.buttons)) {
      const p = local(e)
      if (p) setAt({ x: p.x, y: p.y })
    }
  }
  const onPointerUp = (e: RPointerEvent<HTMLDivElement>) => {
    setDragging(false)
    if (e.pointerType !== 'mouse') setAt(null)
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return
    const step = e.shiftKey ? 10 : 2
    const next: Record<string, () => void> = {
      ArrowLeft: () => setSplit((s) => clamp(s - step)),
      ArrowRight: () => setSplit((s) => clamp(s + step)),
      Home: () => setSplit(0),
      End: () => setSplit(100),
    }
    if (!video) next.l = next.L = toggleLoupe
    const fn = next[e.key]
    if (fn) {
      e.preventDefault()
      e.stopPropagation()
      fn()
    }
  }

  const toggleLoupe = () => {
    const r = stage.current?.getBoundingClientRect()
    if (r?.width) setGeo({ w: r.width, h: r.height })
    setLoupe((on) => !on)
  }

  useEffect(() => {
    if (!globalLoupeKey || video) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (e.key.toLowerCase() !== 'l' || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return
      if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return
      e.preventDefault()
      const r = stage.current?.getBoundingClientRect()
      if (r?.width) setGeo({ w: r.width, h: r.height })
      setLoupe((on) => !on)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [globalLoupeKey, video])

  // keep the follower clip on the leader's frame
  useEffect(() => {
    if (!video) return
    let raf = 0
    const tick = () => {
      const a = vids.current.after
      const b = vids.current.before
      if (a && b && Math.abs(a.currentTime - b.currentTime) > 0.05) b.currentTime = a.currentTime
      if (a) setTime({ t: a.currentTime, d: a.duration || 0 })
      raf = requestAnimationFrame(tick)
    }
    if (playing) raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, video])

  const play = () => {
    const a = vids.current.after
    const b = vids.current.before
    if (!a) return
    if (a.paused) {
      if (b) b.currentTime = a.currentTime
      void a.play()?.catch(() => {})
      void b?.play()?.catch(() => {})
      setPlaying(true)
    } else {
      a.pause()
      b?.pause()
      setPlaying(false)
    }
  }
  const seek = (t: number) => {
    for (const v of [vids.current.after, vids.current.before]) if (v) v.currentTime = t
    setTime((x) => ({ ...x, t }))
  }

  const media = (which: 'before' | 'after') => {
    const src = which === 'before' ? before : after
    const label = `${which === 'before' ? beforeLabel : afterLabel}: ${alt}`
    return video ? (
      <video
        ref={(el) => {
          vids.current[which] = el
        }}
        src={src}
        aria-label={label}
        muted={which === 'before'}
        playsInline
        preload="metadata"
        onLoadedMetadata={(e) => which === 'after' && setTime({ t: 0, d: e.currentTarget.duration || 0 })}
        onEnded={() => setPlaying(false)}
        className="absolute inset-0 size-full object-contain"
      />
    ) : (
      <img
        src={src}
        onLoad={(e) => {
          const { naturalWidth: w, naturalHeight: h } = e.currentTarget
          setNat((n) => ({ ...n, [which]: w && h ? { w, h } : null }))
        }}
        alt={label}
        draggable={false}
        className="absolute inset-0 size-full object-contain"
      />
    )
  }

  // the loupe sits on the pointer, or on the divider when it was switched on from the keyboard
  let lens: React.ReactNode = null
  if (loupe && !video && geo) {
    const p = at ?? { x: (split / 100) * geo.w, y: geo.h / 2 }
    const side = (p.x / geo.w) * 100 < split ? 'before' : 'after'
    const nw = nat[side]?.w ?? 0
    const nh = nat[side]?.h ?? 0
    if (nw && nh) {
      const r = containedRect(geo.w, geo.h, nw, nh)
      const ix = ((p.x - r.x) / r.w) * nw
      const iy = ((p.y - r.y) / r.h) * nh
      if (ix >= 0 && iy >= 0 && ix <= nw && iy <= nh) {
        lens = (
          <div
            data-testid="loupe"
            aria-hidden
            className="pointer-events-none absolute rounded-full border-2 border-studio-gold shadow-modal"
            style={{
              width: LOUPE,
              height: LOUPE,
              left: p.x - LOUPE / 2,
              top: p.y - LOUPE / 2,
              backgroundImage: `url("${side === 'before' ? before : after}")`,
              backgroundRepeat: 'no-repeat',
              backgroundSize: `${nw}px ${nh}px`,
              backgroundPosition: `${LOUPE / 2 - ix}px ${LOUPE / 2 - iy}px`,
              imageRendering: 'pixelated',
            }}
          />
        )
      }
    }
  }

  return (
    <figure className={cn('flex flex-col gap-2', className)} onKeyDown={onKeyDown}>
      <div
        ref={stage}
        className={cn('darkroom relative w-full touch-none select-none overflow-hidden rounded-[6px]', aspectClass ?? 'min-h-48 flex-1', loupe ? 'cursor-crosshair' : 'cursor-ew-resize')}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={(e) => e.pointerType === 'mouse' && setAt(null)}
      >
        {media('before')}
        <div className="absolute inset-0" style={{ clipPath: `inset(0 0 0 ${split}%)` }}>
          {media('after')}
        </div>
        <div
          role="slider"
          tabIndex={0}
          aria-label="Before and after divider"
          aria-describedby={`${uid}-keys`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(split)}
          aria-valuetext={`${Math.round(100 - split)}% ${afterLabel.toLowerCase()} showing`}
          className="absolute inset-y-0 z-10 flex w-8 -translate-x-1/2 cursor-ew-resize justify-center focus-visible:outline-none [&:focus-visible>span:last-child]:ring-2 [&:focus-visible>span:last-child]:ring-[var(--accent)]"
          style={{ left: `${split}%` }}
        >
          <span aria-hidden className="h-full w-0.5 bg-studio-gold" />
          <span aria-hidden className="absolute top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-full bg-studio-darkroom/85 text-[11px] text-studio-on-dark ring-1 ring-studio-gold">
            ⇆
          </span>
        </div>
        <span aria-hidden className="pointer-events-none absolute left-2 top-2 rounded bg-studio-darkroom/80 px-1.5 text-small text-studio-on-dark">
          {beforeLabel}
        </span>
        <span aria-hidden className="pointer-events-none absolute right-2 top-2 rounded bg-studio-darkroom/80 px-1.5 text-small text-studio-on-dark">
          {afterLabel}
        </span>
        {lens}
      </div>
      <figcaption className="flex flex-wrap items-center gap-2 text-small text-studio-muted">
        {video ? (
          <>
            <button type="button" onClick={play} className="inline-flex h-8 items-center gap-1 rounded-[6px] border border-studio-border-strong bg-studio-raised px-2 text-studio-text" aria-label={playing ? 'Pause both' : 'Play both'}>
              {playing ? <Pause aria-hidden className="size-3.5" /> : <Play aria-hidden className="size-3.5" />}
              {playing ? 'Pause' : 'Play'}
            </button>
            <input
              type="range"
              min={0}
              max={time.d || 0}
              step={0.04}
              value={time.t}
              onChange={(e) => seek(Number(e.target.value))}
              aria-label="Position in both clips"
              className="min-w-32 flex-1 accent-[var(--accent)]"
            />
          </>
        ) : (
          <button
            type="button"
            aria-pressed={loupe}
            onClick={toggleLoupe}
            className={cn('inline-flex h-8 items-center gap-1 rounded-[6px] border px-2 text-studio-text', loupe ? 'border-studio-accent bg-studio-accent-soft' : 'border-studio-border-strong bg-studio-raised')}
          >
            <Search aria-hidden className="size-3.5" />
            1:1 loupe <Kbd>L</Kbd>
          </button>
        )}
        <span id={`${uid}-keys`} className="ml-auto">
          Drag the divider, or <Kbd>←</Kbd> <Kbd>→</Kbd> · <Kbd>Home</Kbd> <Kbd>End</Kbd>
        </span>
      </figcaption>
    </figure>
  )
}
