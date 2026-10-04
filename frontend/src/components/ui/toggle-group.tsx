import * as React from 'react'
import { ToggleGroup as TG } from 'radix-ui'
import { cn } from '@/lib/utils'

// Segmented control; Radix gives us roving focus with arrow keys.
export function ToggleGroup({ className, ...props }: React.ComponentProps<typeof TG.Root>) {
  return (
    <TG.Root
      className={cn('inline-flex rounded-[6px] border border-studio-border-strong bg-studio-raised p-0.5', className)}
      {...props}
    />
  )
}

export function ToggleGroupItem({ className, ...props }: React.ComponentProps<typeof TG.Item>) {
  return (
    <TG.Item
      className={cn(
        'inline-flex h-7 flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-[4px] px-3 text-body text-studio-muted transition-colors duration-150 hover:text-studio-text data-[state=on]:bg-studio-accent data-[state=on]:text-studio-accent-fg [&_svg]:size-3.5',
        className,
      )}
      {...props}
    />
  )
}
