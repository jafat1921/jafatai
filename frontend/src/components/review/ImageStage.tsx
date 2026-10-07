import { useId } from 'react'
import { Columns2, SplitSquareHorizontal } from 'lucide-react'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { imageResolutionBadge } from '@/lib/imageUpscale'
import type { Generation } from '@/lib/types'
import { ZoomView, type CompareMode, type ZoomImage } from './ZoomView'

const tagFor = (g: Generation) => {
  const badge = imageResolutionBadge(g)
  return badge ? `Upscaled · ${badge}` : `Original · v${g.version}`
}

/** The still on screen in a GenerationViewer: zoom/pan, and the compare views when there's a partner. */
export function ImageStage({
  current,
  partner,
  subject,
  mode,
}: {
  current: Generation
  partner?: Generation
  subject: string
  mode: CompareMode
}) {
  const image: ZoomImage = { url: current.media_url!, alt: `${subject}, version ${current.version}`, label: partner && tagFor(current) }
  const other: ZoomImage | undefined = partner && {
    url: partner.media_url!,
    alt: `${subject}, version ${partner.version}`,
    label: tagFor(partner),
  }
  return <ZoomView key={current.id} image={image} other={other} mode={partner ? mode : 'off'} />
}

export function CompareToggle({ mode, onChange }: { mode: CompareMode; onChange: (m: CompareMode) => void }) {
  const labelId = useId()
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span id={labelId} className="section-label">
        Compare
      </span>
      <ToggleGroup type="single" aria-labelledby={labelId} value={mode} onValueChange={(v) => onChange((v || 'off') as CompareMode)}>
        <ToggleGroupItem value="off">Off</ToggleGroupItem>
        <ToggleGroupItem value="side">
          <Columns2 aria-hidden />
          Side by side
        </ToggleGroupItem>
        <ToggleGroupItem value="swipe">
          <SplitSquareHorizontal aria-hidden />
          Swipe
        </ToggleGroupItem>
      </ToggleGroup>
    </div>
  )
}
