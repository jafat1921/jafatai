import * as React from 'react'
import { ScrollArea as SA } from 'radix-ui'
import { cn } from '@/lib/utils'

export function ScrollArea({
  className,
  children,
  orientation = 'vertical',
  viewportClassName,
  ...props
}: React.ComponentProps<typeof SA.Root> & { orientation?: 'vertical' | 'horizontal'; viewportClassName?: string }) {
  return (
    <SA.Root className={cn('relative overflow-hidden', className)} {...props}>
      {/* Radix wraps children in display:table, which defeats truncate/line-clamp in vertical lists */}
      <SA.Viewport
        className={cn('size-full rounded-[inherit]', orientation === 'vertical' && '[&>div]:!block', viewportClassName)}
      >
        {children}
      </SA.Viewport>
      <SA.Scrollbar
        orientation={orientation}
        className={cn(
          'flex touch-none select-none p-0.5 transition-colors',
          orientation === 'vertical' ? 'h-full w-2.5' : 'h-2.5 flex-col',
        )}
      >
        <SA.Thumb className="relative flex-1 rounded-full bg-studio-border hover:bg-studio-border-strong" />
      </SA.Scrollbar>
      <SA.Corner />
    </SA.Root>
  )
}
