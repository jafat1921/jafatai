import type { Generation } from '@/lib/types'
import { isVideo } from '@/lib/media'
import { cn } from '@/lib/utils'

// Image or video for a generation. Videos start muted (autoplaying sound is hostile) with native controls.
export function GenerationMedia({
  gen,
  alt,
  className,
  controls = true,
  lazy,
}: {
  gen: Generation
  alt: string
  className?: string
  controls?: boolean
  lazy?: boolean
}) {
  if (!gen.media_url) return null
  if (isVideo(gen)) {
    return (
      <video
        src={gen.media_url}
        aria-label={alt}
        className={cn('size-full object-contain', className)}
        controls={controls}
        muted
        playsInline
        loop
        preload="metadata"
      />
    )
  }
  return (
    <img src={gen.media_url} alt={alt} className={cn('size-full object-contain', className)} loading={lazy ? 'lazy' : undefined} />
  )
}
