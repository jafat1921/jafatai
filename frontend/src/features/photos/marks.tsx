import { Flag, Star, X } from 'lucide-react'
import { LABELS, type Label } from '@/lib/catalogue'
import type { MediaItem } from '@/lib/types'
import { cn } from '@/lib/utils'

/** Read-only marks for tiles and the loupe overlay. */
export function MarksBadge({ item, className, dark }: { item: MediaItem; className?: string; dark?: boolean }) {
  const label = LABELS.find((l) => l.id === item.label)
  const rating = item.rating ?? 0
  return (
    <span className={cn('flex items-center gap-1.5', className)}>
      {item.flag === 'pick' && <Flag aria-label="Pick" className="size-3.5 fill-current text-studio-success" />}
      {item.flag === 'reject' && <X aria-label="Rejected" className="size-3.5 text-studio-danger" strokeWidth={3} />}
      {rating > 0 && (
        <span aria-label={`${rating} star${rating === 1 ? '' : 's'}`} className={cn('flex', dark ? 'text-studio-gold' : 'text-studio-accent')}>
          {Array.from({ length: rating }, (_, i) => (
            <Star key={i} aria-hidden className="size-3 fill-current" />
          ))}
        </span>
      )}
      {label && <span aria-label={`${label.name} label`} className="size-2.5 rounded-full ring-1 ring-black/20" style={{ background: label.swatch }} />}
    </span>
  )
}

/** Click a star to set it, click the current one again to clear (Lightroom behaviour). */
export function StarPicker({ value, onChange, size = 'md' }: { value: number; onChange: (n: number) => void; size?: 'sm' | 'md' }) {
  return (
    <div role="radiogroup" aria-label="Rating" className="flex items-center">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={value === n}
          aria-label={`${n} star${n === 1 ? '' : 's'}`}
          title={`${n} (key ${n})`}
          onClick={() => onChange(value === n ? 0 : n)}
          className={cn('rounded-[4px] p-0.5 text-studio-accent hover:bg-studio-panel-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-studio-accent', size === 'sm' ? '[&_svg]:size-3.5' : '[&_svg]:size-5')}
        >
          <Star aria-hidden className={cn(n <= value ? 'fill-current' : 'opacity-40')} />
        </button>
      ))}
    </div>
  )
}

export function FlagPicker({ value, onChange }: { value: string; onChange: (f: 'pick' | 'reject' | 'none') => void }) {
  const opts = [
    { id: 'pick', label: 'Pick', key: 'P', icon: <Flag aria-hidden className="size-4 fill-current" />, on: 'bg-studio-success text-white' },
    { id: 'none', label: 'Unflagged', key: 'U', icon: <Flag aria-hidden className="size-4" />, on: 'bg-studio-raised' },
    { id: 'reject', label: 'Reject', key: 'X', icon: <X aria-hidden className="size-4" strokeWidth={3} />, on: 'bg-studio-danger text-white' },
  ] as const
  const current = value || 'none'
  return (
    <div role="radiogroup" aria-label="Flag" className="flex gap-1">
      {opts.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={current === o.id}
          title={`${o.label} (key ${o.key})`}
          onClick={() => onChange(o.id)}
          className={cn(
            'flex h-7 items-center gap-1 rounded-[6px] border border-studio-border-strong px-2 text-small focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-studio-accent',
            current === o.id ? o.on : 'text-studio-muted hover:bg-studio-panel-hover',
          )}
        >
          {o.icon}
          <span>{o.label}</span>
        </button>
      ))}
    </div>
  )
}

export function LabelPicker({ value, onChange }: { value: string; onChange: (l: Label | 'none') => void }) {
  return (
    <div role="radiogroup" aria-label="Colour label" className="flex items-center gap-1.5">
      {LABELS.map((l) => (
        <button
          key={l.id}
          type="button"
          role="radio"
          aria-checked={value === l.id}
          aria-label={l.name}
          title={l.key ? `${l.name} (key ${l.key})` : l.name}
          onClick={() => onChange(value === l.id ? 'none' : l.id)}
          className={cn(
            'size-5 rounded-full ring-offset-2 ring-offset-studio-panel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-studio-accent',
            value === l.id ? 'ring-2 ring-studio-text' : 'opacity-80 hover:opacity-100',
          )}
          style={{ background: l.swatch }}
        />
      ))}
    </div>
  )
}
