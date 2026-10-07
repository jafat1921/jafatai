import { fieldClass } from '@/components/ui/input'
import type { ModelInfo } from '@/lib/types'
import { cn } from '@/lib/utils'

/** Compact dropdown for dense panels. Unavailable models stay listed but can't be chosen. */
export function ModelSelect({
  id,
  models,
  value,
  onChange,
  className,
  describedBy,
}: {
  id: string
  models: ModelInfo[]
  value: string | undefined
  onChange: (id: string) => void
  className?: string
  describedBy?: string
}) {
  return (
    <select
      id={id}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value)}
      aria-describedby={describedBy}
      className={cn(fieldClass, 'h-8 text-body', className)}
    >
      {models.map((m) => (
        <option key={m.id} value={m.id} disabled={!m.available}>
          {m.label}
          {m.badge ? ` · ${m.badge}` : ''}
          {m.available ? '' : ' (unavailable)'}
        </option>
      ))}
    </select>
  )
}
