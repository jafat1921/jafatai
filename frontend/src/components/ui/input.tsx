import * as React from 'react'
import { cn } from '@/lib/utils'

export const fieldClass =
  'w-full rounded-[6px] border border-studio-border-strong bg-studio-raised px-2.5 text-body text-studio-text transition-colors duration-150 hover:border-studio-border-hover focus-visible:border-studio-accent focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-studio-gold/50 disabled:opacity-50 aria-[invalid=true]:border-studio-danger'

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type = 'text', ...props }, ref) => (
    <input ref={ref} type={type} className={cn(fieldClass, 'h-8', className)} {...props} />
  ),
)
Input.displayName = 'Input'
