import { Check, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useMediaHost } from '@/components/generate/useMediaHost'
import type { MediaItem } from '@/lib/types'
import { cn } from '@/lib/utils'
import { useFavourites } from '@/stores/favourites'
import { announce } from '@/stores/ui'
import { AudioTile } from '../AudioTile'

export interface ComparePair {
  a: { item: MediaItem; label: string }
  b: { item: MediaItem; label: string }
  kept: 'a' | 'b' | null
}

/** The A/B pair from the last Compare: two players side by side, and "Keep" stars the winner. */
export function CompareBoard({ pair, onKeep, onClose }: { pair: ComparePair; onKeep: (side: 'a' | 'b') => void; onClose: () => void }) {
  const { handlers, host } = useMediaHost({ items: [pair.a.item, pair.b.item] })
  const favs = useFavourites()

  const keep = (side: 'a' | 'b') => {
    const { item, label } = pair[side]
    if (!favs.ids.includes(item.id)) favs.toggle(item.id)
    onKeep(side)
    announce(`Kept ${side.toUpperCase()}: ${label}. It's starred in the Library.`)
  }

  return (
    <section aria-labelledby="ab-title" className="rounded-[8px] border border-studio-border-strong bg-studio-panel p-3">
      <div className="mb-2 flex items-center gap-2">
        <h2 id="ab-title" className="section-label">
          A/B compare
        </h2>
        <p className="text-small text-studio-faint">Same line, two voices. Play each, then keep the one you prefer.</p>
        <Button type="button" size="icon-sm" variant="ghost" onClick={onClose} aria-label="Close the comparison" className="ml-auto">
          <X aria-hidden />
        </Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 sm:divide-x sm:divide-studio-border">
        {(['a', 'b'] as const).map((side) => (
          <div key={side} className={cn('flex min-w-0 flex-col gap-2', side === 'b' && 'sm:pl-3')}>
            <p className="flex min-w-0 items-baseline gap-1.5 text-small">
              <span className="font-mono font-semibold">{side.toUpperCase()}</span>
              <span className="truncate text-studio-muted">{pair[side].label}</span>
            </p>
            <AudioTile item={pair[side].item} handlers={handlers} ratio="3 / 1" />
            <Button type="button" size="sm" variant={pair.kept === side ? 'primary' : 'secondary'} aria-pressed={pair.kept === side} onClick={() => keep(side)} className="self-start">
              {pair.kept === side && <Check aria-hidden />}
              Keep {side.toUpperCase()}
            </Button>
          </div>
        ))}
      </div>
      {host}
    </section>
  )
}
