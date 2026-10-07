import { useEffect, useId, useRef, useState } from 'react'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { CompareSource } from '@/lib/upscale'
import { cn } from '@/lib/utils'


/**
 * One <video> whose src swaps between two files; the playhead and play state carry across
 * so you see the same moment in both.
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
    if (!id || id === active.id) return
    const v = ref.current
    if (v) resume.current = { t: v.currentTime, playing: !v.paused }
    setActiveId(id)
  }

  useEffect(() => {
    const v = ref.current
    if (!v) return
    const onMeta = () => {
      const r = resume.current
      if (!r) return
      resume.current = null
      v.currentTime = Math.min(r.t, v.duration || r.t)
      if (r.playing) v.play().catch(() => {})
    }
    v.addEventListener('loadedmetadata', onMeta)
    return () => v.removeEventListener('loadedmetadata', onMeta)
  }, [])

  return (
    <div className="flex flex-col gap-2">
      {sources.length > 1 && (
        <div className="flex flex-wrap items-center gap-2">
          <span id={labelId} className="section-label">
            Compare
          </span>
          <ToggleGroup type="single" aria-labelledby={labelId} value={active.id} onValueChange={switchTo}>
            {sources.map((s) => (
              <ToggleGroupItem key={s.id} value={s.id}>
                {s.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      )}
      <div className={cn('darkroom w-full overflow-hidden rounded-[6px]', aspectClass)}>
        <video
          ref={ref}
          src={active.url}
          controls
          autoPlay
          playsInline
          className="size-full object-contain"
          aria-label={`${title}, ${active.label}`}
        />
      </div>
    </div>
  )
}
