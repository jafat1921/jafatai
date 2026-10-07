import { useId } from 'react'
import { Link } from 'react-router'
import { Stamp } from 'lucide-react'
import { fieldClass } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import type { BrandChoice } from '@/hooks/useBrandKits'
import { cn } from '@/lib/utils'

/** "Brand: [kit ▾] · On/Off" on every generator. Off sends nothing, so the server behaves as before. */
export function BrandChip({ choice, className }: { choice: BrandChoice; className?: string }) {
  const uid = useId()
  const { kits, kit, on, setKit, setOn } = choice

  if (!kits.length) {
    return (
      <p className={cn('inline-flex items-center gap-1.5 self-start rounded-full border border-studio-border px-2.5 py-1 text-small text-studio-muted', className)}>
        <Stamp aria-hidden className="size-3.5" />
        Brand: none ·{' '}
        <Link to="/brand-kits" className="text-studio-accent-hover underline underline-offset-2">
          Create a brand kit
        </Link>
      </p>
    )
  }

  return (
    <div
      role="group"
      aria-label="Brand kit"
      className={cn(
        'inline-flex flex-wrap items-center gap-2 self-start rounded-full border px-2.5 py-1 text-small transition-colors duration-150',
        on ? 'border-studio-accent bg-studio-accent-soft' : 'border-studio-border-strong bg-studio-raised',
        className,
      )}
    >
      <Stamp aria-hidden className="size-3.5 text-studio-accent-hover" />
      <label htmlFor={`${uid}-kit`} className="font-medium">
        Brand:
      </label>
      <select
        id={`${uid}-kit`}
        value={kit?.id ?? ''}
        onChange={(e) => setKit(e.target.value)}
        className={cn(fieldClass, 'h-6 w-auto max-w-44 py-0 pr-6 text-small')}
      >
        {kits.map((k) => (
          <option key={k.id} value={k.id}>
            {k.name}
            {k.is_default ? ' (default)' : ''}
          </option>
        ))}
      </select>
      <span aria-hidden className="text-studio-muted">
        ·
      </span>
      <Switch id={`${uid}-on`} checked={on} onCheckedChange={setOn} aria-label="Use the brand kit" />
      <label htmlFor={`${uid}-on`} className="min-w-6 text-studio-muted">
        {on ? 'On' : 'Off'}
      </label>
    </div>
  )
}
