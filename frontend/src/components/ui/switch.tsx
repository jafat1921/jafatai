import * as React from 'react'
import { Switch as SW } from 'radix-ui'
import { cn } from '@/lib/utils'

export function Switch({ className, ...props }: React.ComponentProps<typeof SW.Root>) {
  return (
    <SW.Root
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-studio-border-strong bg-studio-raised transition-colors duration-150 data-[state=checked]:border-studio-accent data-[state=checked]:bg-studio-accent',
        className,
      )}
      {...props}
    >
      <SW.Thumb className="block size-3.5 translate-x-0.5 rounded-full bg-studio-muted transition-transform duration-150 data-[state=checked]:translate-x-[18px] data-[state=checked]:bg-studio-accent-fg" />
    </SW.Root>
  )
}
