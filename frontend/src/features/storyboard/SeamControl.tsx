import { Link2, Scissors } from 'lucide-react'
import { Kbd } from '@/components/ui/kbd'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { SeamMode } from '@/lib/types'
import { cn } from '@/lib/utils'

// The seam *into* a shot: Cut = fresh START, Continue = START is the previous END (PLAN §2c).
export function SeamControl({
  value,
  onChange,
  fromLabel,
  toLabel,
  active,
}: {
  value: SeamMode
  onChange: (v: SeamMode) => void
  fromLabel: string
  toLabel: string
  // the row below is selected, so L acts on this seam
  active?: boolean
}) {
  return (
    <div
      className={cn('flex items-center gap-2 py-1 pl-6', value === 'continue' ? 'text-studio-accent-hover' : 'text-studio-muted')}
      role="group"
      aria-label={`Seam from ${fromLabel} to ${toLabel}`}
    >
      <span aria-hidden className={cn('h-5 w-px', value === 'continue' ? 'bg-studio-gold' : 'bg-studio-border-strong')} />
      <ToggleGroup
        type="single"
        value={value}
        onValueChange={(v) => v && onChange(v as SeamMode)}
        aria-label={`Seam into ${toLabel}`}
        className="p-0.5"
      >
        <ToggleGroupItem value="cut" className="h-6 px-2 text-small" aria-label="Cut: fresh START frame">
          <Scissors aria-hidden />
          Cut
        </ToggleGroupItem>
        <ToggleGroupItem value="continue" className="h-6 px-2 text-small" aria-label="Continue: START is the previous END frame">
          <Link2 aria-hidden />
          Continue
        </ToggleGroupItem>
      </ToggleGroup>
      {value === 'continue' && (
        <span className="inline-flex items-center gap-1 text-small">
          <Link2 aria-hidden className="size-3" />
          linked to {fromLabel} END
        </span>
      )}
      {active && (
        <span className="ml-auto hidden pr-2 text-small text-studio-muted sm:inline">
          <Kbd>L</Kbd> toggles
        </span>
      )}
    </div>
  )
}
