import { useEffect, useRef, useState } from 'react'
import { Film, Info, Pause, Play, SkipBack, SkipForward } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { playlist, renderIsFresh } from '@/lib/reel'
import type { Reel } from '@/lib/types'
import { cn } from '@/lib/utils'

/**
 * Plays the last assembled film when it still matches the edit. Otherwise it plays the clips one after
 * another, honouring trims; transitions only exist in the assembled file.
 */
export function ReelPlayer({ reel, labelFor, aspectClass }: { reel: Reel; labelFor: (shotId: string) => string; aspectClass: string }) {
  const fresh = renderIsFresh(reel)
  if (fresh && reel.last_render?.media_url) {
    return (
      <figure className="flex flex-col gap-1">
        <div className={cn('darkroom w-full overflow-hidden rounded-[6px]', aspectClass)}>
          <video src={reel.last_render.media_url} controls playsInline preload="metadata" className="size-full object-contain" aria-label="Assembled film" />
        </div>
        <figcaption className="text-small text-studio-muted">Playing the last assembled film (v{reel.last_render.version}).</figcaption>
      </figure>
    )
  }
  return <ClipSequence reel={reel} labelFor={labelFor} aspectClass={aspectClass} />
}

function ClipSequence({ reel, labelFor, aspectClass }: { reel: Reel; labelFor: (shotId: string) => string; aspectClass: string }) {
  const items = playlist(reel)
  const video = useRef<HTMLVideoElement>(null)
  const [index, setIndex] = useState(0)
  const [playing, setPlaying] = useState(false)
  const i = Math.min(index, Math.max(0, items.length - 1))
  const item = items[i]

  // a new clip loads: jump to its in point and keep going if we were playing
  useEffect(() => {
    const v = video.current
    if (!v || !item) return
    const start = () => {
      v.currentTime = item.in
      if (playing) void v.play().catch(() => setPlaying(false))
    }
    if (v.readyState >= 1) start()
    else v.addEventListener('loadedmetadata', start, { once: true })
    return () => v.removeEventListener('loadedmetadata', start)
    // only re-run when the clip changes, not on every play/pause
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.clip.id, item?.in])

  if (!items.length) {
    return (
      <div className={cn('darkroom flex w-full flex-col items-center justify-center gap-2 rounded-[6px] text-studio-on-dark-muted', aspectClass)}>
        <Film aria-hidden className="size-6" />
        <p className="text-small">Nothing to play yet.</p>
      </div>
    )
  }

  const go = (n: number) => setIndex(Math.max(0, Math.min(items.length - 1, n)))
  const toggle = () => {
    const v = video.current
    if (!v) return
    if (v.paused) {
      setPlaying(true)
      void v.play().catch(() => setPlaying(false))
    } else {
      setPlaying(false)
      v.pause()
    }
  }

  return (
    <figure className="flex flex-col gap-2">
      <div className={cn('darkroom relative w-full overflow-hidden rounded-[6px]', aspectClass)}>
        <video
          ref={video}
          src={item.clip.media_url}
          playsInline
          preload="metadata"
          className="size-full object-contain"
          aria-label={`Reel preview, clip ${labelFor(item.clip.shot_id)}`}
          onTimeUpdate={(e) => {
            if (e.currentTarget.currentTime < item.out - 0.04) return
            if (i < items.length - 1) setIndex(i + 1)
            else {
              e.currentTarget.pause()
              setPlaying(false)
            }
          }}
          onEnded={() => (i < items.length - 1 ? setIndex(i + 1) : setPlaying(false))}
        />
        <span className="absolute left-2 top-2 rounded-[4px] bg-studio-darkroom/85 px-1.5 font-mono text-small text-studio-on-dark">
          {i + 1} / {items.length} · {labelFor(item.clip.shot_id)}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button size="sm" variant="ghost" aria-label="Previous clip" onClick={() => go(i - 1)} disabled={i === 0}>
          <SkipBack aria-hidden />
        </Button>
        <Button size="sm" variant="primary" onClick={toggle}>
          {playing ? <Pause aria-hidden /> : <Play aria-hidden />}
          {playing ? 'Pause' : 'Play reel'}
        </Button>
        <Button size="sm" variant="ghost" aria-label="Next clip" onClick={() => go(i + 1)} disabled={i === items.length - 1}>
          <SkipForward aria-hidden />
        </Button>
        <figcaption className="flex min-w-0 flex-1 items-start gap-1 text-small text-studio-muted">
          <Info aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          Clip-by-clip preview with your trims. Dissolves and fades show only in the assembled film.
        </figcaption>
      </div>
    </figure>
  )
}
