import { ChevronLeft, ChevronRight, EyeOff, Film, Sparkle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { clipWidth } from '@/lib/reel'
import { formatTimecode } from '@/lib/duration'
import type { ReelClip } from '@/lib/types'
import { cn } from '@/lib/utils'

interface Props {
  clip: ReelClip
  label: string
  description?: string
  selected: boolean
  first: boolean
  last: boolean
  moving?: boolean
  onSelect: () => void
  onMove: (dir: -1 | 1) => void
}

function Thumb({ clip, alt }: { clip: ReelClip; alt: string }) {
  if (clip.thumb_url) return <img src={clip.thumb_url} alt={alt} className="size-full object-cover" loading="lazy" />
  if (clip.media_url) {
    // first frame after the trim, without downloading the whole file
    return (
      <video
        src={`${clip.media_url}#t=${Math.max(0.05, clip.trim_in_s)}`}
        aria-label={alt}
        className="size-full object-cover"
        muted
        playsInline
        preload="metadata"
      />
    )
  }
  return <Film aria-hidden className="size-5 text-studio-on-dark-muted" />
}

export function ClipCard({ clip, label, description, selected, first, last, moving, onSelect, onMove }: Props) {
  const alt = `Shot ${label}${description ? `: ${description}` : ''}`
  return (
    <div className="flex shrink-0 flex-col gap-1" style={{ width: clipWidth(clip.duration_s) }}>
      <button
        type="button"
        aria-pressed={selected}
        aria-label={`Clip ${label}, ${formatTimecode(clip.duration_s)}${clip.enabled ? '' : ', left out of the film'}${clip.changed ? ', take changed since last assemble' : ''}`}
        onClick={onSelect}
        className={cn(
          'darkroom relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-[6px]',
          selected ? 'ring-2 ring-studio-accent ring-offset-2 ring-offset-studio-panel' : 'hover:brightness-110',
          !clip.enabled && 'opacity-50',
        )}
      >
        <Thumb clip={clip} alt={alt} />
        <span className="absolute left-1 top-1 rounded-[4px] bg-studio-darkroom/85 px-1 font-mono text-[11px] text-studio-on-dark">
          {label}
        </span>
        <span className="absolute bottom-1 right-1 rounded-[4px] bg-studio-darkroom/85 px-1 font-mono text-[11px] text-studio-on-dark">
          {formatTimecode(clip.duration_s)}
        </span>
        {clip.changed && (
          <span className="absolute right-1 top-1 inline-flex items-center gap-0.5 rounded-full bg-studio-darkroom/85 px-1.5 text-[11px] text-studio-on-dark">
            <Sparkle aria-hidden className="size-3" />
            New take
          </span>
        )}
        {!clip.enabled && (
          <span className="absolute bottom-1 left-1 inline-flex items-center gap-0.5 rounded-full bg-studio-darkroom/85 px-1.5 text-[11px] text-studio-on-dark">
            <EyeOff aria-hidden className="size-3" />
            Off
          </span>
        )}
      </button>
      <div className="flex items-center justify-between">
        <Button
          size="icon-sm"
          variant="ghost"
          className="size-6"
          aria-label={`Move clip ${label} earlier`}
          disabled={first || moving}
          onClick={() => onMove(-1)}
        >
          <ChevronLeft aria-hidden />
        </Button>
        <span className="min-w-0 flex-1 truncate px-1 text-center text-[11px] text-studio-muted">{description}</span>
        <Button
          size="icon-sm"
          variant="ghost"
          className="size-6"
          aria-label={`Move clip ${label} later`}
          disabled={last || moving}
          onClick={() => onMove(1)}
        >
          <ChevronRight aria-hidden />
        </Button>
      </div>
    </div>
  )
}
