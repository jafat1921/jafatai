import { useId, useRef, useState } from 'react'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { BeforeAfter } from '@/components/media/BeforeAfter'
import type { CompareSource } from '@/lib/upscale'
import { cn } from '@/lib/utils'

const SLIDER = 'slider'

/**
 * One <video> whose src swaps between two files; the playhead and play state carry across
 * so you see the same moment in both. With two sources there's also a frame-synced wipe.
 */
export function ComparePlayer({
  sources,
  aspectClass,
  title,
}: {
  sources: [CompareSource, CompareSource] | [CompareSource]
  aspectClass: string
  title: string
}) {
  const ref = useRef<HTMLVideoElement>(null)
  const labelId = useId()
  const [activeId, setActiveId] = useState(sources[0].id)
  const resume = useRef<{ t: number; playing: boolean } | null>(null)
  const active = sources.find((s) => s.id === activeId) ?? sources[0]

  const switchTo = (id: string) => {
    if (!id || id === activeId) return
    if (id === SLIDER || activeId === SLIDER) {
      resume.current = null
      setActiveId(id)
      return
    }
    const v = ref.current
    if (v) resume.current = { t: v.currentTime, playing: !v.paused }
    setActiveId(id)
  }

  // a prop handler, not a listener added once: the <video> remounts after the slider view
  const onMeta = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    const v = e.currentTarget
    const r = resume.current
    if (!r) return
    resume.current = null
    v.currentTime = Math.min(r.t, v.duration || r.t)
    if (r.playing) v.play()?.catch(() => {})
  }

  return (
    <div className="flex flex-col gap-2">
      {sources.length > 1 && (
        <div className="flex flex-wrap items-center gap-2">
          <span id={labelId} className="section-label">
            Compare
          </span>
          <ToggleGroup type="single" aria-labelledby={labelId} value={activeId === SLIDER ? SLIDER : active.id} onValueChange={switchTo}>
            {sources.map((s) => (
              <ToggleGroupItem key={s.id} value={s.id}>
                {s.label}
              </ToggleGroupItem>
            ))}
            <ToggleGroupItem value={SLIDER}>Slider</ToggleGroupItem>
          </ToggleGroup>
        </div>
      )}
      {activeId === SLIDER && sources.length > 1 ? (
        <SliderCompare sources={sources as [CompareSource, CompareSource]} aspectClass={aspectClass} title={title} />
      ) : (
        <div className={cn('darkroom w-full overflow-hidden rounded-[6px]', aspectClass)}>
          <video
          ref={ref}
          src={active.url}
          controls
          autoPlay
          playsInline
          onLoadedMetadata={onMeta}
          className="size-full object-contain"
          aria-label={`${title}, ${active.label}`}
        />
      </div>
      )}
    </div>
  )
}

function SliderCompare({ sources, aspectClass, title }: { sources: [CompareSource, CompareSource]; aspectClass: string; title: string }) {
  // the original goes on the left whichever of the two is playing
  const original = sources.find((s) => s.label.startsWith('Original')) ?? sources[1]
  const other = sources.find((s) => s !== original) ?? sources[0]
  return <BeforeAfter kind="video" before={original.url} after={other.url} alt={title} beforeLabel={original.label} afterLabel={other.label} aspectClass={aspectClass} />
}
