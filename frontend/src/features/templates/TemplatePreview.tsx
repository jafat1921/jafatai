import { useState } from 'react'
import { Clapperboard, ImageIcon } from 'lucide-react'
import type { Template } from '@/lib/types'
import { cn } from '@/lib/utils'

/** The shipped example picture for a prompt template, or its kind's icon when there is none (or it fails). */
export function TemplatePreview({
  t,
  className,
  iconClassName,
  decorative,
}: {
  t: Template
  className?: string
  iconClassName?: string
  // inside a menu item the title already names it
  decorative?: boolean
}) {
  const src = t.preview_url ?? t.thumb ?? null
  const [broken, setBroken] = useState(false)
  const Icon = t.type === 'video' ? Clapperboard : ImageIcon
  return (
    <div className={cn('darkroom flex items-center justify-center overflow-hidden', className)}>
      {src && !broken ? (
        <img
          src={src}
          alt={decorative ? '' : `Example: ${t.title}`}
          className={cn('size-full', decorative ? 'object-cover' : 'object-contain')}
          loading="lazy"
          decoding="async"
          onError={() => setBroken(true)}
        />
      ) : (
        <Icon aria-hidden data-testid="preview-fallback" className={cn('size-7 text-studio-on-dark-muted', iconClassName)} />
      )}
    </div>
  )
}
