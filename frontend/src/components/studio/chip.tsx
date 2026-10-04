import * as React from 'react'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'

interface ChipProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  selected?: boolean
  icon?: React.ReactNode
}

export const Chip = React.forwardRef<HTMLButtonElement, ChipProps>(
  ({ selected, icon, className, children, ...props }, ref) => (
    <button
      ref={ref}
      type="button"
      aria-pressed={selected}
      className={cn(
        'inline-flex h-7 items-center gap-1 rounded-[6px] border px-2 text-small transition-colors duration-150 [&_svg]:size-3',
        selected
          ? 'border-studio-accent bg-studio-accent-soft text-studio-text'
          : 'border-studio-border-strong bg-studio-raised text-studio-muted hover:text-studio-text hover:bg-studio-panel-hover',
        className,
      )}
      {...props}
    >
      {selected ? <Check aria-hidden className="text-studio-accent-hover" /> : icon}
      {children}
    </button>
  ),
)
Chip.displayName = 'Chip'

interface ChipGroupProps<T extends string> {
  label: string
  options: readonly { value: T; label: string }[]
  value: T | null
  onChange: (value: T | null) => void
  // clicking the selected chip again clears it
  allowEmpty?: boolean
  className?: string
}

export function ChipGroup<T extends string>({
  label,
  options,
  value,
  onChange,
  allowEmpty = true,
  className,
}: ChipGroupProps<T>) {
  const id = React.useId()
  return (
    <div className={className} role="group" aria-labelledby={id}>
      <div id={id} className="section-label mb-1.5">
        {label}
      </div>
      <div className="flex flex-wrap gap-1">
        {options.map((o) => (
          <Chip
            key={o.value}
            selected={value === o.value}
            onClick={() => onChange(value === o.value && allowEmpty ? null : o.value)}
          >
            {o.label}
          </Chip>
        ))}
      </div>
    </div>
  )
}
