import * as React from 'react'
import { Slot } from 'radix-ui'
import { cva, type VariantProps } from 'class-variance-authority'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

export const buttonVariants = cva(
  'relative inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-[6px] font-medium transition-colors duration-150 select-none disabled:pointer-events-none disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50 [&_svg]:shrink-0 [&_svg]:size-4',
  {
    variants: {
      variant: {
        primary: 'bg-studio-accent text-studio-accent-fg hover:bg-studio-accent-hover active:bg-studio-accent-pressed',
        secondary:
          'bg-studio-raised text-studio-text border border-studio-border-strong hover:bg-studio-panel-hover hover:border-studio-border-hover',
        ghost: 'text-studio-muted hover:text-studio-text hover:bg-studio-panel-hover',
        danger: 'bg-studio-danger text-studio-accent-fg hover:brightness-110',
        outline: 'border border-studio-border-strong text-studio-text hover:bg-studio-panel-hover',
      },
      size: {
        sm: 'h-7 px-2.5 text-small',
        md: 'h-8 px-3 text-body',
        lg: 'h-10 px-4 text-body',
        icon: 'size-8',
        'icon-sm': 'size-7',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
  loading?: boolean
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild, loading, children, disabled, ...props }, ref) => {
    if (asChild) {
      return (
        <Slot.Root ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props}>
          {children}
        </Slot.Root>
      )
    }
    return (
      <button
        ref={ref}
        className={cn(buttonVariants({ variant, size }), className)}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        {...props}
      >
        {/* keep the label in the layout so the button doesn't change width while loading */}
        <span className={cn('inline-flex items-center gap-1.5', loading && 'opacity-0')}>{children}</span>
        {loading && <Loader2 className="absolute animate-spin" aria-hidden />}
      </button>
    )
  },
)
Button.displayName = 'Button'
