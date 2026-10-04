import * as React from 'react'
import { Tabs as TabsPrimitive } from 'radix-ui'
import { cn } from '@/lib/utils'

export const Tabs = TabsPrimitive.Root
export const TabsContent = TabsPrimitive.Content

export function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return <TabsPrimitive.List className={cn('flex items-center gap-1', className)} {...props} />
}

export function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        'inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-[6px] px-2.5 text-body font-medium text-studio-muted transition-colors duration-150 hover:bg-studio-panel-hover hover:text-studio-text aria-selected:bg-studio-accent aria-selected:text-studio-accent-fg aria-selected:shadow-[inset_0_-2px_0_var(--accent-gold)] [&_svg]:size-3.5',
        className,
      )}
      {...props}
    />
  )
}
