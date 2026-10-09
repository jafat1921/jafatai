import * as React from 'react'
import { Collapsible } from 'radix-ui'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

interface SectionProps {
  title: string
  count?: number
  icon?: React.ReactNode
  defaultOpen?: boolean
  action?: React.ReactNode
  children: React.ReactNode
  className?: string
  // controlled use (solo mode, Ctrl+1…9 in Photo Studio)
  open?: boolean
  onOpenChange?: (open: boolean) => void
  // muted title when the group is switched off
  dimmed?: boolean
}

export function Section({ title, count, icon, defaultOpen = true, action, children, className, open: openProp, onOpenChange, dimmed }: SectionProps) {
  const [own, setOwn] = React.useState(defaultOpen)
  const open = openProp ?? own
  const setOpen = (o: boolean) => (onOpenChange ? onOpenChange(o) : setOwn(o))
  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} className={cn('py-1', className)}>
      <div className="flex items-center gap-1 pr-1">
        <Collapsible.Trigger className="group flex flex-1 items-center gap-1.5 rounded-[4px] px-1 py-1 text-left hover:bg-studio-panel-hover">
          <ChevronRight
            aria-hidden
            className="size-3.5 text-studio-muted transition-transform duration-150 group-data-[state=open]:rotate-90"
          />
          {icon}
          <span className={cn('text-body font-medium', dimmed && 'text-studio-muted line-through decoration-studio-muted/60')}>{title}</span>
          {count !== undefined && <span className="text-small text-studio-muted">({count})</span>}
        </Collapsible.Trigger>
        {action}
      </div>
      <Collapsible.Content className="pt-1.5">{children}</Collapsible.Content>
    </Collapsible.Root>
  )
}
