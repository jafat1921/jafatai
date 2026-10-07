import { ChevronDown } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

const CHIP =
  'inline-flex h-8 max-w-full items-center gap-1.5 rounded-full border px-3 text-small transition-colors duration-150 [&_svg]:size-3.5 [&_svg]:shrink-0'

const chipClass = (active?: boolean) =>
  cn(
    CHIP,
    active
      ? 'border-studio-accent bg-studio-accent-soft text-studio-text'
      : 'border-studio-border-strong bg-studio-raised text-studio-text hover:bg-studio-panel-hover',
  )

interface Props {
  // what the chip is ("Model"); read by screen readers before the value
  name: string
  value: React.ReactNode
  icon?: React.ReactNode
  active?: boolean
  children: React.ReactNode
  wide?: boolean
  // print "Brand:" before the value on the chip itself
  showName?: boolean
}

/** "Model ▾" style chip: the current value on the chip, the full picker in a popover. */
export function DockChip({ name, value, icon, active, children, wide, showName }: Props) {
  return (
    <Popover>
      <PopoverTrigger className={chipClass(active)} aria-label={`${name}: ${typeof value === 'string' ? value : ''}`.replace(/: $/, '')}>
        {icon}
        <span className="truncate">
          {showName && <span className="text-studio-muted">{name}: </span>}
          {value}
        </span>
        <ChevronDown aria-hidden className="text-studio-muted" />
      </PopoverTrigger>
      <PopoverContent
        aria-label={name}
        collisionPadding={12}
        className={cn('flex max-h-[min(70vh,560px)] flex-col gap-3 overflow-y-auto', wide ? 'w-[min(680px,calc(100vw-24px))]' : 'w-[min(380px,calc(100vw-24px))]')}
      >
        {children}
      </PopoverContent>
    </Popover>
  )
}
