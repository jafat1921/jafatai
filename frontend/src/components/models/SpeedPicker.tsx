import { useId } from 'react'
import { RadioGroup } from 'radix-ui'
import { estimateSeconds, secondsText } from '@/lib/models'
import type { ModelInfo } from '@/lib/types'

/** Full · Lightning 4-step · Turbo 2-step, each with its step count and a rough time per image. */
export function SpeedPicker({ model, value, onChange }: { model: ModelInfo; value: string | undefined; onChange: (id: string) => void }) {
  const uid = useId()
  if (!model.speeds?.length) return null
  return (
    <div>
      <div id={uid} className="section-label mb-2">
        Speed
      </div>
      <RadioGroup.Root aria-labelledby={uid} value={value ?? ''} onValueChange={onChange} className="flex flex-wrap gap-1.5">
        {model.speeds.map((s) => {
          const est = estimateSeconds(model, s.id)
          const off = s.available === false
          const detail = off
            ? s.reason || 'Not available on this server yet'
            : [`${s.steps} ${s.steps === 1 ? 'step' : 'steps'}`, est ? `about ${secondsText(est)}` : null, s.note].filter(Boolean).join(' · ')
          return (
            <RadioGroup.Item
              key={s.id}
              value={s.id}
              disabled={off}
              aria-label={`${s.label}: ${detail}`}
              className="flex flex-col items-start rounded-[6px] border border-studio-border-strong bg-studio-raised px-2.5 py-1.5 text-left transition-colors duration-150 hover:bg-studio-panel-hover data-[state=checked]:border-studio-accent data-[state=checked]:bg-studio-accent-soft disabled:cursor-not-allowed disabled:opacity-70"
            >
              <span aria-hidden className="text-body font-medium text-studio-text">
                {s.label}
              </span>
              <span aria-hidden className="text-small text-studio-muted">
                {detail}
              </span>
            </RadioGroup.Item>
          )
        })}
      </RadioGroup.Root>
    </div>
  )
}
