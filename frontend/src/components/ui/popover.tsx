import * as React from 'react'
import { Popover as PO } from 'radix-ui'
import { cn } from '@/lib/utils'

export const Popover = PO.Root
export const PopoverTrigger = PO.Trigger
export const PopoverClose = PO.Close

export function PopoverContent({ className, sideOffset = 6, align = 'start', ...props }: React.ComponentProps<typeof PO.Content>) {
  return (
    <PO.Portal>
      <PO.Content
        sideOffset={sideOffset}
        align={align}
        className={cn(
          'z-50 w-72 rounded-[6px] border border-studio-border-strong bg-studio-panel p-3 shadow-pop data-[state=open]:animate-fade-in',
          className,
        )}
        {...props}
      />
    </PO.Portal>
  )
}
