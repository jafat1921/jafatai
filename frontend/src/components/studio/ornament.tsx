import { cn } from '@/lib/utils'

// Fine double rule with a small fleuron. Login and empty states only (design-system restraint rule).
export function Ornament({ className }: { className?: string }) {
  return (
    <div aria-hidden className={cn('flex items-center gap-2 text-studio-gold', className)}>
      <span className="h-[3px] w-10 border-y border-current opacity-70" />
      <span className="font-display text-[15px] leading-none">❦</span>
      <span className="h-[3px] w-10 border-y border-current opacity-70" />
    </div>
  )
}
