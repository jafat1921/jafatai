import { useNavigate } from 'react-router'
import { ArrowUpRight, Clapperboard, Film, ImageUpscale, LayoutGrid, Megaphone, Smartphone, Sparkles, Stamp, Type, Users } from 'lucide-react'
import { useBrandKits } from '@/hooks/useBrandKits'
import { useStartTemplate } from '@/hooks/useStudio'
import { BRAND_RECIPES, defaultKit, RECIPES, recipeRoute, type Recipe } from '@/lib/recipes'
import { TARGET_ROUTE, type TemplatePrefill } from '@/lib/templates'
import { cn } from '@/lib/utils'

const ICONS = {
  film: Film,
  ad: Megaphone,
  sheet: Users,
  animate: Clapperboard,
  poster: Type,
  upscale: ImageUpscale,
  reveal: Stamp,
  photo: Sparkles,
  teaser: Smartphone,
}

function Card({ r, onOpen, busy }: { r: Recipe; onOpen: () => void; busy: boolean }) {
  const Icon = ICONS[r.icon]
  return (
    <li className="flex">
      <button
        type="button"
        onClick={onOpen}
        aria-busy={busy || undefined}
        className={cn(
          'group flex w-full flex-col gap-1.5 rounded-[8px] border border-studio-border-strong bg-studio-panel p-3 text-left shadow-card transition-colors duration-150',
          'hover:border-studio-accent hover:bg-studio-panel-hover focus-visible:border-studio-accent',
          busy && 'opacity-70',
        )}
      >
        <span className="flex items-center gap-2">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-[6px] bg-studio-accent-soft text-studio-accent-hover">
            <Icon aria-hidden className="size-4" />
          </span>
          <span className="min-w-0 flex-1 font-display text-heading font-semibold">{r.title}</span>
          <ArrowUpRight aria-hidden className="size-4 text-studio-muted transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
        </span>
        <span className="text-small text-studio-muted">{r.blurb}</span>
      </button>
    </li>
  )
}

/** Blueprints: curated starting points. Opening one fills the tool in; nothing runs until you press Generate. */
export function Recipes() {
  const navigate = useNavigate()
  const start = useStartTemplate()
  const { kits } = useBrandKits()

  const open = (r: Recipe) => {
    const go = (path: string, prefill: Record<string, unknown>) => {
      const template: TemplatePrefill = { templateId: r.templateId ?? `recipe:${r.id}`, templateTitle: r.title, prefill }
      const q = r.query ? `?${new URLSearchParams(r.query)}` : ''
      navigate(`${path}${q}`, { state: { template } })
    }
    if (!r.templateId) {
      if (r.prefill) go(recipeRoute(r, kits), r.prefill)
      else navigate(recipeRoute(r, kits))
      return
    }
    start.mutate(r.templateId, {
      onSuccess: (s) => go(TARGET_ROUTE[s.target] ?? TARGET_ROUTE.quick, s.prefill ?? {}),
      // an older server without that template still gets you to the right tool
      onError: () => go(r.templateId!.startsWith('image') ? TARGET_ROUTE.image : TARGET_ROUTE.quick, {}),
    })
  }

  const busy = (r: Recipe) => start.isPending && start.variables === r.templateId
  return (
    <section aria-labelledby="home-blueprints" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 border-b border-studio-border pb-1">
        <LayoutGrid aria-hidden className="size-4 text-studio-accent" />
        <h2 id="home-blueprints" className="font-display text-panel font-semibold">
          Blueprints
        </h2>
        <span className="text-small text-studio-muted">Start from a recipe; you review everything before it runs.</span>
      </div>
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-3">
        {RECIPES.map((r) => (
          <Card key={r.id} r={r} busy={busy(r)} onOpen={() => open(r)} />
        ))}
      </ul>
      {kits.length > 0 && (
        <section aria-labelledby="home-instant-brand" className="mt-2 flex flex-col gap-2">
          <h3 id="home-instant-brand" className="section-label">
            Instant brand · {defaultKit(kits)?.name}
          </h3>
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-3">
            {BRAND_RECIPES.map((r) => (
              <Card key={r.id} r={r} busy={busy(r)} onOpen={() => open(r)} />
            ))}
          </ul>
        </section>
      )}
    </section>
  )
}
