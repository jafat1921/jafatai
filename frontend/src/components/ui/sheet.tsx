import * as React from 'react'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'

export const Sheet = DialogPrimitive.Root
export const SheetTitle = DialogPrimitive.Title
export const SheetDescription = DialogPrimitive.Description

export function SheetContent({
  className,
  children,
  overlay = true,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & { overlay?: boolean }) {
  return (
    <DialogPrimitive.Portal>
      {overlay && <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-[rgb(42_28_15/0.2)] data-[state=open]:animate-fade-in" />}
      <DialogPrimitive.Content
        className={cn(
          'glass fixed inset-y-0 right-0 z-50 flex w-[420px] max-w-full flex-col border-l border-studio-border-strong shadow-modal data-[state=open]:animate-slide-in-right data-[state=closed]:animate-slide-out-right focus-visible:outline-none',
          className,
        )}
        {...props}
      >
        {children}
        <DialogPrimitive.Close
          className="absolute right-3 top-3.5 rounded-[6px] p-1.5 text-studio-muted hover:bg-studio-panel-hover hover:text-studio-text"
          aria-label="Close"
        >
          <X className="size-4" />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
}
