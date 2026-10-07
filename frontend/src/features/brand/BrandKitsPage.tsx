import { Link, useNavigate } from 'react-router'
import { Plus, Stamp, Star } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState, ErrorState } from '@/components/studio/states'
import { useBrandKits, useCreateKit, useSetDefaultKit } from '@/hooks/useBrandKits'
import type { BrandKit } from '@/lib/brand'
import { announce } from '@/stores/ui'

function KitCard({ kit }: { kit: BrandKit }) {
  const setDefault = useSetDefaultKit()
  const logo = kit.logos?.primary ?? kit.logos?.dark ?? kit.logos?.light
  const url = logo ? kit.assets?.[logo.media_id]?.media_url : null
  return (
    <li className="flex flex-col overflow-hidden rounded-[8px] border border-studio-border-strong bg-studio-panel shadow-card">
      <Link to={`/brand-kits/${kit.id}`} className="group flex flex-1 flex-col gap-2 p-3 hover:bg-studio-panel-hover" aria-label={`Open ${kit.name}`}>
        <div className="checker flex aspect-[16/9] items-center justify-center overflow-hidden rounded-[6px] border border-studio-border">
          {url ? <img src={url} alt="" className="max-h-[70%] max-w-[70%] object-contain" /> : <Stamp aria-hidden className="size-8 text-studio-muted" />}
        </div>
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate font-display text-panel font-semibold">{kit.name}</span>
          {kit.is_default && (
            <span className="inline-flex items-center gap-1 rounded-full border border-studio-gold/70 bg-studio-gold/10 px-2 text-small">
              <Star aria-hidden className="size-3" />
              Default
            </span>
          )}
        </div>
        {kit.palette?.length > 0 && (
          <div className="flex gap-1" aria-label={`Palette: ${kit.palette.map((c) => c.name || c.hex).join(', ')}`} role="img">
            {kit.palette.map((c) => (
              <span key={c.hex} className="h-4 flex-1 rounded-[3px] border border-studio-border" style={{ background: c.hex }} />
            ))}
          </div>
        )}
        {kit.tagline && (
          <p dir="auto" className="line-clamp-1 text-small text-studio-muted">
            {kit.tagline}
          </p>
        )}
      </Link>
      {!kit.is_default && (
        <div className="border-t border-studio-border p-2">
          <Button
            size="sm"
            variant="ghost"
            loading={setDefault.isPending}
            onClick={() => setDefault.mutate(kit.id, { onSuccess: () => announce(`${kit.name} is now the default brand kit.`) })}
          >
            <Star aria-hidden />
            Make default
          </Button>
        </div>
      )}
    </li>
  )
}

export function BrandKitsPage() {
  const navigate = useNavigate()
  const { kits, isPending, isError, error, refetch } = useBrandKits()
  const create = useCreateKit()
  const start = () => create.mutate(kits.length ? 'New brand' : 'My brand', { onSuccess: (k) => navigate(`/brand-kits/${k.id}`) })

  return (
    <main data-f6-region tabIndex={-1} className="h-full overflow-y-auto focus-visible:outline-none" aria-label="Brand kits">
      <div className="mx-auto flex max-w-6xl flex-col gap-5 px-4 py-6 md:px-8">
        <header className="flex flex-wrap items-center gap-3">
          <Stamp aria-hidden className="size-5 text-studio-accent-hover" />
          <div className="min-w-0 flex-1">
            <h1 className="font-display text-title font-semibold">Brand Kits</h1>
            <p className="text-small text-studio-muted">Your logo, products, colours and voice. Adverts place them inside the scenes: on packaging, signs, screens and a closing shot.</p>
          </div>
          <Button variant="primary" onClick={start} loading={create.isPending}>
            <Plus aria-hidden />
            New brand kit
          </Button>
        </header>
        {create.isError && <ErrorState compact title="Couldn't create the kit" error={create.error} />}

        {isPending ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="aspect-[4/3]" />
            ))}
          </div>
        ) : isError && !kits.length ? (
          <ErrorState error={error} onRetry={() => refetch()} />
        ) : kits.length === 0 ? (
          <EmptyState
            icon={<Stamp />}
            title="No brand kits yet"
            action={
              <Button variant="primary" onClick={start} loading={create.isPending}>
                <Plus aria-hidden />
                Create your first kit
              </Button>
            }
          >
            Add your logo and products once. Every generator can then use them, and adverts show them in the scenes.
          </EmptyState>
        ) : (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4" aria-label="Your brand kits">
            {kits.map((k) => (
              <KitCard key={k.id} kit={k} />
            ))}
          </ul>
        )}
      </div>
    </main>
  )
}
