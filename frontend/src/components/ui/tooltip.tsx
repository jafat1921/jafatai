import * as React from 'react'
import { Tooltip as TP } from 'radix-ui'
import { cn } from '@/lib/utils'

export const TooltipProvider = TP.Provider

export function Tooltip({
  content,
  children,
  side = 'top',
  className,
}: {
  content: React.ReactNode
  children: React.ReactNode
  side?: React.ComponentProps<typeof TP.Content>['side']
  className?: string
}) {
  return (
    <TP.Root>
      <TP.Trigger asChild>{children}</TP.Trigger>
      <TP.Portal>
        <TP.Content
          side={side}
          sideOffset={6}
          className={cn(
            'z-[60] max-w-64 rounded-[4px] border border-studio-border-strong bg-studio-raised px-2 py-1 text-small text-studio-text shadow-pop data-[state=delayed-open]:animate-fade-in',
            className,
          )}
        >
          {content}
        </TP.Content>
      </TP.Portal>
    </TP.Root>
  )
}
