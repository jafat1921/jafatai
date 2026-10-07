import { Timer } from 'lucide-react'
import { DurationFields } from '@/components/studio/duration-picker'
import { DockChip } from '@/components/generate/DockChip'
import { formatDuration } from '@/lib/duration'
import { rangeText } from '@/lib/estimate'
import type { EstimateResult, ModelInfo } from '@/lib/types'
import { durationPresets, maxDuration } from '@/lib/video'

interface Props {
  model: ModelInfo | undefined
  value: number
  onChange: (s: number) => void
  estimate: EstimateResult | null
}

/** Length: 5 · 10 · 20 · 30 s · 1 min · custom, with the time it will take right under it. */
export function LengthChip({ model, value, onChange, estimate }: Props) {
  const max = maxDuration(model)
  return (
    <DockChip name="Length" value={formatDuration(value)} icon={<Timer aria-hidden />}>
      <DurationFields
        // remount when the cap changes so the custom box re-validates against it
        key={`${model?.id}-${max}`}
        label="Length"
        value={value}
        onChange={onChange}
        presets={durationPresets(model)}
        max={max}
        limitNoun={` with ${model?.label ?? 'this model'}`}
        estimateLine={
          estimate ? (
            <p aria-live="polite" className="text-small text-studio-muted">
              <span className="font-mono text-studio-text">{formatDuration(value)}</span> clip · about {rangeText(estimate.low_s, estimate.high_s).replace(/^~/, '')} to make
              {estimate.basis === 'measured' ? ' (measured on this server)' : ' (rough)'}
            </p>
          ) : null
        }
      />
    </DockChip>
  )
}
