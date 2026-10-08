import { useState } from 'react'
import { Film, ImageIcon, ImageOff } from 'lucide-react'
import type { MediaItem } from '@/lib/types'
import { cn } from '@/lib/utils'

const bust = (url: string) => `${url}${url.includes('?') ? '&' : '?'}retry=1`

/**
 * The picture inside a grid tile: the server's small webp thumb (media_url only as a fallback),
 * a skeleton until it decodes, one retry, then a plain "Preview unavailable" instead of a dark box.
 */
export function TilePicture({ item, alt, fallbackUrl }: { item: MediaItem; alt: string; fallbackUrl?: string | null }) {
  const url = item.thumb_url ?? item.media_url ?? fallbackUrl ?? null
  // a video without a server thumb (older server) can only show itself
  const asVideo = item.kind === 'video' && !item.thumb_url
  const [tries, setTries] = useState(0)
  const [loaded, setLoaded] = useState(false)
  const [seen, setSeen] = useState(url)
  if (seen !== url) {
    // the item moved to a new version: start over
    setSeen(url)
    setTries(0)
    setLoaded(false)
  }

  if (!url) {
    return (
      <span className="flex size-full items-center justify-center text-studio-on-dark-muted">
        {item.kind === 'video' ? <Film aria-hidden className="size-6" /> : <ImageIcon aria-hidden className="size-6" />}
        <span className="sr-only">{alt}</span>
      </span>
    )
  }
  if (tries > 1) {
    return (
      <span role="img" aria-label={`${alt}: preview unavailable`} className="flex size-full flex-col items-center justify-center gap-1 p-2 text-center text-studio-on-dark-muted">
        <ImageOff aria-hidden className="size-5" />
        <span className="text-small">Preview unavailable</span>
      </span>
    )
  }
  const src = tries === 1 ? bust(url) : url
  const failed = () => {
    setLoaded(false)
    setTries((t) => t + 1)
  }
  const media = 'size-full object-cover transition-opacity duration-200'
  return (
    <>
      {!loaded && <span aria-hidden data-testid="tile-skeleton" className="shimmer-dark absolute inset-0" />}
      {asVideo ? (
        <video key={src} src={src} aria-label={alt} muted playsInline preload="metadata" onLoadedData={() => setLoaded(true)} onError={failed} className={cn(media, !loaded && 'opacity-0')} />
      ) : (
        <img key={src} src={src} alt={alt} loading="lazy" decoding="async" onLoad={() => setLoaded(true)} onError={failed} className={cn(media, !loaded && 'opacity-0')} />
      )}
    </>
  )
}

/** "Upscaled · 4K" on a tile whose current version is an upscale. */
export function UpscaledBadge({ item, className }: { item: Pick<MediaItem, 'upscale'>; className?: string }) {
  if (!item.upscale) return null
  return (
    <span className={cn('pointer-events-none absolute bottom-1.5 left-1.5 rounded-[4px] bg-studio-darkroom/85 px-1.5 font-mono text-[11px] text-studio-on-dark', className)}>
      Upscaled · {item.upscale.label}
    </span>
  )
}
