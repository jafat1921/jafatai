import { Lock } from 'lucide-react'
import type { Source } from '@/lib/types'
import { cn } from '@/lib/utils'

// ✎ / ✦ / ◐ from PLAN 2b — always glyph plus word, never colour alone.
const SOURCES: Record<Source, { glyph: string; label: string; title: string; cls: string }> = {
  user: { glyph: '✎', label: 'user', title: 'Written by you', cls: 'text-studio-text' },
  ai: { glyph: '✦', label: 'AI', title: 'Written by AI', cls: 'text-studio-accent-hover' },
  ai_edited: { glyph: '◐', label: 'mixed', title: 'AI draft, edited by you', cls: 'text-studio-warning' },
}

export function SourceBadge({ source, locked, className }: { source: Source; locked?: boolean; className?: string }) {
  const s = SOURCES[source] ?? SOURCES.user
  return (
    <span
      className={cn('inline-flex items-center gap-1 text-small text-studio-muted', className)}
      title={locked ? `${s.title} · locked, AI won't overwrite it` : s.title}
    >
      <span aria-hidden className={s.cls}>
        {s.glyph}
      </span>
      <span>{s.label}</span>
      {locked && (
        <>
          <Lock aria-hidden className="size-3" />
          <span className="sr-only">locked</span>
        </>
      )}
    </span>
  )
}
