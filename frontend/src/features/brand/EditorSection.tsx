import { useId } from 'react'
import { cn } from '@/lib/utils'

export function EditorSection({
  title,
  hint,
  children,
  aside,
  className,
}: {
  title: string
  hint?: React.ReactNode
  children: React.ReactNode
  aside?: React.ReactNode
  className?: string
}) {
  const id = useId()
  return (
    <section aria-labelledby={id} className={cn('flex flex-col gap-3 rounded-[8px] border border-studio-border-strong bg-studio-panel p-4 shadow-card', className)}>
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 id={id} className="font-display text-panel font-semibold">
            {title}
          </h2>
          {hint && <p className="text-small text-studio-muted">{hint}</p>}
        </div>
        {aside}
      </div>
      {children}
    </section>
  )
}

export type AssetUrls = Record<string, string | null | undefined>
