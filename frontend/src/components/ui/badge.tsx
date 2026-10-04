import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

export const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full border px-2 h-5 text-small font-medium whitespace-nowrap [&_svg]:size-3 [&_svg]:shrink-0',
  {
    variants: {
      tone: {
        neutral: 'border-studio-border-strong bg-studio-raised text-studio-muted',
        accent: 'border-studio-accent/40 bg-studio-accent-soft text-studio-accent-hover',
        success: 'border-studio-success/60 bg-transparent text-studio-success',
        warning: 'border-studio-warning/35 bg-studio-warning/10 text-studio-warning',
        danger: 'border-studio-danger/40 bg-studio-danger/10 text-studio-danger',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
)

export function Badge({
  className,
  tone,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />
}
