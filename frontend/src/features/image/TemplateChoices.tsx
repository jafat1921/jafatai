import { useId } from 'react'
import { fieldClass } from '@/components/ui/input'
import type { TemplateOption } from '@/lib/types'
import { cn } from '@/lib/utils'

/** The pickers an edit template offers (hairstyle, lighting…); each one writes into its [slot]. */
export function TemplateChoices({
  options,
  picked,
  onPick,
}: {
  options: TemplateOption[]
  picked: Record<string, number>
  onPick: (option: TemplateOption, index: number) => void
}) {
  const uid = useId()
  if (!options.length) return null
  return (
    <div role="group" aria-label="Template choices" className="flex flex-wrap items-end gap-3">
      {options.map((o, n) => (
        <div key={o.slot} className="flex flex-col gap-1">
          <label htmlFor={`${uid}-${n}`} className="text-small font-medium">
            {o.label}
          </label>
          <select
            id={`${uid}-${n}`}
            value={picked[o.slot] ?? ''}
            onChange={(e) => e.target.value !== '' && onPick(o, Number(e.target.value))}
            className={cn(fieldClass, 'h-8 w-auto max-w-60 py-0 pr-7 text-small')}
          >
            <option value="" disabled>
              Choose…
            </option>
            {o.choices.map((c, i) => (
              <option key={c.label} value={i}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
      ))}
    </div>
  )
}
