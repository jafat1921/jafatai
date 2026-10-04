import { RadioGroup } from 'radix-ui'
import { cn } from '@/lib/utils'

const ASPECTS = [
  { value: '16:9', label: 'Landscape', size: '1280×720', w: 32, h: 18 },
  { value: '9:16', label: 'Portrait', size: '720×1280', w: 13, h: 22 },
  { value: '1:1', label: 'Square', size: '1024×1024', w: 20, h: 20 },
  { value: '2.39:1', label: 'Cinema', size: '1280×536', w: 34, h: 14 },
] as const

export function AspectTiles({
  value,
  onChange,
  labelledBy,
}: {
  value: string
  onChange: (v: string) => void
  labelledBy?: string
}) {
  return (
    <RadioGroup.Root
      value={value}
      onValueChange={onChange}
      aria-labelledby={labelledBy}
      className="grid grid-cols-4 gap-2"
    >
      {ASPECTS.map((a) => (
        <RadioGroup.Item
          key={a.value}
          value={a.value}
          aria-label={`${a.value} ${a.label}, ${a.size}`}
          className={cn(
            'flex flex-col items-center gap-1 rounded-[6px] border p-2 text-center transition-colors duration-150',
            'border-studio-border-strong bg-studio-raised text-studio-muted hover:bg-studio-panel-hover',
            'data-[state=checked]:border-studio-accent data-[state=checked]:bg-studio-accent-soft data-[state=checked]:text-studio-text',
          )}
        >
          <span className="flex h-6 items-center" aria-hidden>
            <span className="rounded-[2px] border-[1.5px] border-current" style={{ width: a.w, height: a.h }} />
          </span>
          <span aria-hidden className="text-small font-medium">{a.value}</span>
          <span className="text-small leading-tight">{a.label}</span>
          <span className="font-mono text-[11px] text-studio-muted">{a.size}</span>
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  )
}
