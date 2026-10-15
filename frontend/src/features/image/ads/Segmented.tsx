import { cn } from '@/lib/utils'
import { useRoving } from './useRoving'

/** A small segmented radiogroup (mask shape, copy side, draft/final). */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled,
  className,
  describedBy,
}: {
  label: string
  options: readonly { id: T; label: string }[]
  value: T
  onChange: (v: T) => void
  disabled?: boolean
  className?: string
  describedBy?: string
}) {
  const ids = options.map((o) => o.id)
  const { box, tabStop, onKeyDown } = useRoving(ids, value, onChange)
  return (
    <div
      ref={box}
      role="radiogroup"
      aria-label={label}
      aria-describedby={describedBy}
      aria-disabled={disabled || undefined}
      className={cn('inline-flex flex-wrap rounded-[6px] border border-studio-border-strong bg-studio-raised p-0.5', className)}
    >
      {options.map((o, i) => {
        const on = o.id === value
        return (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={disabled}
            tabIndex={i === tabStop ? 0 : -1}
            onClick={() => onChange(o.id)}
            onKeyDown={(e) => onKeyDown(i, e)}
            className={cn(
              'inline-flex h-7 flex-1 items-center justify-center whitespace-nowrap rounded-[4px] px-3 text-small transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-studio-accent disabled:opacity-50',
              on ? 'bg-studio-accent text-studio-accent-fg' : 'text-studio-muted hover:text-studio-text',
            )}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}
