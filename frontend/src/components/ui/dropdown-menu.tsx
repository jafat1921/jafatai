import * as React from 'react'
import { DropdownMenu as DM } from 'radix-ui'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'

export const DropdownMenu = DM.Root
export const DropdownMenuTrigger = DM.Trigger
export const DropdownMenuRadioGroup = DM.RadioGroup
export const DropdownMenuGroup = DM.Group

export function DropdownMenuContent({ className, sideOffset = 6, ...props }: React.ComponentProps<typeof DM.Content>) {
  return (
    <DM.Portal>
      <DM.Content
        sideOffset={sideOffset}
        className={cn(
          'z-50 min-w-48 overflow-hidden rounded-[6px] border border-studio-border-strong bg-studio-panel p-1 shadow-pop data-[state=open]:animate-fade-in',
          className,
        )}
        {...props}
      />
    </DM.Portal>
  )
}

const itemClass =
  'relative flex cursor-default select-none items-center gap-2 rounded-[4px] px-2 py-1.5 text-body text-studio-text outline-none data-[highlighted]:bg-studio-panel-hover data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:size-4 [&_svg]:text-studio-muted'

export function DropdownMenuItem({ className, ...props }: React.ComponentProps<typeof DM.Item>) {
  return <DM.Item className={cn(itemClass, className)} {...props} />
}

export function DropdownMenuRadioItem({ className, children, ...props }: React.ComponentProps<typeof DM.RadioItem>) {
  return (
    <DM.RadioItem className={cn(itemClass, 'pl-7', className)} {...props}>
      <DM.ItemIndicator className="absolute left-2 inline-flex">
        <Check className="text-studio-accent-hover" />
      </DM.ItemIndicator>
      {children}
    </DM.RadioItem>
  )
}

export function DropdownMenuCheckboxItem({ className, children, ...props }: React.ComponentProps<typeof DM.CheckboxItem>) {
  return (
    <DM.CheckboxItem className={cn(itemClass, 'pl-7', className)} {...props}>
      <DM.ItemIndicator className="absolute left-2 inline-flex">
        <Check className="text-studio-accent-hover" />
      </DM.ItemIndicator>
      {children}
    </DM.CheckboxItem>
  )
}

export function DropdownMenuLabel({ className, ...props }: React.ComponentProps<typeof DM.Label>) {
  return <DM.Label className={cn('section-label px-2 py-1.5', className)} {...props} />
}

export function DropdownMenuSeparator({ className, ...props }: React.ComponentProps<typeof DM.Separator>) {
  return <DM.Separator className={cn('-mx-1 my-1 h-px bg-studio-border', className)} {...props} />
}

export function DropdownMenuShortcut({ children }: { children: React.ReactNode }) {
  return <span className="ml-auto pl-4 font-mono text-small text-studio-muted">{children}</span>
}
