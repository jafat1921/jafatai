import { isVideo } from '@/lib/media'
import { kindLabel } from '@/lib/status'
import type { Generation } from '@/lib/types'

const MAX_TILES = 12

/** The newest things autopilot made, newest last, each on its own darkroom frame. */
export function PreviewTiles({ items }: { items: Generation[] }) {
  if (!items.length) {
    return <p className="text-small text-studio-muted">Pictures appear here as soon as the first portrait or frame is made.</p>
  }
  const shown = items.slice(-MAX_TILES)
  return (
    <ul aria-label="Made so far" className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6">
      {shown.map((g) => {
        const alt = g.prompt ? `${kindLabel(g.kind)}: ${g.prompt.slice(0, 120)}` : kindLabel(g.kind)
        return (
          <li key={g.id} className="darkroom aspect-video overflow-hidden rounded-[6px] animate-fade-in">
            {isVideo(g) ? (
              <video src={g.media_url!} preload="metadata" muted playsInline aria-label={alt} className="size-full object-cover" />
            ) : (
              <img src={g.media_url!} alt={alt} loading="lazy" className="size-full object-cover" />
            )}
          </li>
        )
      })}
    </ul>
  )
}
