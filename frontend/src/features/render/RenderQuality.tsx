import { useId } from 'react'
import { RadioGroup } from 'radix-ui'
import { Gauge } from 'lucide-react'
import { SwitchRow } from '@/components/studio/switch-row'
import { cn } from '@/lib/utils'
import { ErrorState } from '@/components/studio/states'
import { useRenderOptions, type RenderQuality } from './renderOptions'

const OPTIONS: { value: RenderQuality; title: string; hint: string }[] = [
  { value: 'standard', title: 'Standard', hint: 'LTX-2.3. Faster, with sound; works for long takes.' },
  { value: 'hq', title: 'High quality', hint: 'Two-stage LTX-2.3 at a higher resolution. Slower. Single-chunk shots only.' },
]

export function RenderQualityBar({ projectId }: { projectId: string }) {
  const uid = useId()
  const opts = useRenderOptions(projectId)
  // an older server only has Standard; nothing to choose
  if (!opts.hq && !opts.smooth) return null
  return (
    <div className="mx-5 mb-3 grid gap-3 rounded-[6px] border border-studio-border-strong bg-studio-panel p-3 lg:grid-cols-[2fr_1fr]">
      {opts.hq && (
        <div>
          <div id={`${uid}-q`} className="section-label mb-1.5 flex items-center gap-1">
            <Gauge aria-hidden className="size-3.5" />
            Quality
          </div>
          <RadioGroup.Root
            aria-labelledby={`${uid}-q`}
            value={opts.quality}
            onValueChange={(v) => opts.setQuality(v as RenderQuality)}
            className="grid gap-2 sm:grid-cols-2"
          >
            {OPTIONS.map((o) => {
              const off = o.value === 'hq' && !opts.hq?.available
              const reason = off ? opts.hq?.reason || 'Not installed on the server yet.' : null
              return (
                <RadioGroup.Item
                  key={o.value}
                  value={o.value}
                  disabled={off}
                  aria-label={o.title}
                  aria-describedby={`${uid}-${o.value}`}
                  className={cn(
                    'flex flex-col items-start gap-0.5 rounded-[6px] border border-studio-border-strong bg-studio-raised p-2 text-left transition-colors duration-150 hover:bg-studio-panel-hover',
                    'data-[state=checked]:border-studio-accent data-[state=checked]:bg-studio-accent-soft disabled:cursor-not-allowed disabled:opacity-70',
                  )}
                >
                  <span aria-hidden className="text-body font-medium">
                    {o.title}
                  </span>
                  <span id={`${uid}-${o.value}`} className="text-small text-studio-muted">
                    {reason ?? o.hint}
                  </span>
                </RadioGroup.Item>
              )
            })}
          </RadioGroup.Root>
        </div>
      )}
      {opts.smooth && (
        <SwitchRow
          id={`${uid}-smooth`}
          checked={opts.smoothOn}
          disabled={!opts.smooth.available}
          onChange={opts.setSmooth}
          title="Smooth motion ×2"
          hint={
            opts.smooth.available
              ? 'Doubles the frame rate (24 → 48 fps) for silkier movement. Adds render time; skipped on long takes.'
              : opts.smooth.reason || 'Not available on this server yet.'
          }
          className="self-start"
        />
      )}
      {!!opts.error && <ErrorState compact className="lg:col-span-2" title="Couldn't save the render settings" error={opts.error} />}
    </div>
  )
}
