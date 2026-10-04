import * as React from 'react'
import { AlertDialog as AlertPrimitive } from 'radix-ui'
import { buttonVariants } from './button'
import { overlayClass } from './dialog'

interface ConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: React.ReactNode
  confirmLabel: string
  onConfirm: () => void
  tone?: 'primary' | 'danger'
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  onConfirm,
  tone = 'primary',
}: ConfirmDialogProps) {
  return (
    <AlertPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <AlertPrimitive.Portal>
        <AlertPrimitive.Overlay className={overlayClass} />
        <AlertPrimitive.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-32px)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-[8px] border border-studio-border-strong bg-studio-panel p-5 shadow-modal data-[state=open]:animate-fade-in">
          <AlertPrimitive.Title className="text-title font-display font-semibold">{title}</AlertPrimitive.Title>
          <AlertPrimitive.Description className="mt-2 text-body text-studio-muted">
            {description}
          </AlertPrimitive.Description>
          <div className="mt-5 flex justify-end gap-2">
            <AlertPrimitive.Cancel className={buttonVariants({ variant: 'secondary' })}>Cancel</AlertPrimitive.Cancel>
            <AlertPrimitive.Action className={buttonVariants({ variant: tone })} onClick={onConfirm}>
              {confirmLabel}
            </AlertPrimitive.Action>
          </div>
        </AlertPrimitive.Content>
      </AlertPrimitive.Portal>
    </AlertPrimitive.Root>
  )
}
