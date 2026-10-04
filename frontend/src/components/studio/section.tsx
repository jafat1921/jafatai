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
}

export function Section({ title, count, icon, defaultOpen = true, action, children, className }: SectionProps) {
  const [open, setOpen] = React.useState(defaultOpen)
  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} className={cn('py-1', className)}>
      <div className="flex items-center gap-1 pr-1">
        <Collapsible.Trigger className="group flex flex-1 items-center gap-1.5 rounded-[4px] px-1 py-1 text-left hover:bg-studio-panel-hover">
          <ChevronRight
            aria-hidden
            className="size-3.5 text-studio-muted transition-transform duration-150 group-data-[state=open]:rotate-90"
          />
          {icon}
          <span className="text-body font-medium">{title}</span>
          {count !== undefined && <span className="text-small text-studio-muted">({count})</span>}
        </Collapsible.Trigger>
        {action}
      </div>
      <Collapsible.Content className="pt-1.5">{children}</Collapsible.Content>
    </Collapsible.Root>
  )
}
