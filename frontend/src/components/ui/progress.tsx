import { Progress as ProgressPrimitive } from 'radix-ui'
import { cn } from '@/lib/utils'

export function Progress({ value, label, className }: { value: number | null; label: string; className?: string }) {
  const pct = value == null ? null : Math.round(Math.min(1, Math.max(0, value)) * 100)
  return (
    <ProgressPrimitive.Root
      value={pct}
      aria-label={label}
      className={cn('relative h-1.5 w-full overflow-hidden rounded-full bg-studio-raised', className)}
    >
      <ProgressPrimitive.Indicator
        className={cn(
          'h-full rounded-full bg-studio-accent transition-[width] duration-300',
          pct == null && 'shimmer w-1/3',
        )}
        style={pct == null ? undefined : { width: `${pct}%` }}
      />
    </ProgressPrimitive.Root>
  )
}
