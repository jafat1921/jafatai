import { Calendar, Camera, ChevronDown, Flag, Search, Star, Tag, X, Aperture } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { EMPTY_FILTER, LABELS, filterCount, type FacetValue, type Facets, type FilterState } from '@/lib/catalogue'
import { cn } from '@/lib/utils'

interface Props {
  value: FilterState
  onChange: (f: FilterState) => void
  facets: Facets | undefined
}

const toggleIn = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v])

function Chip({ on, children, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { on: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      {...rest}
      className={cn(
        'flex h-7 items-center gap-1 rounded-full border px-2.5 text-small focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-studio-accent',
        on ? 'border-studio-accent bg-studio-accent text-studio-accent-fg' : 'border-studio-border-strong text-studio-text hover:bg-studio-panel-hover',
      )}
    >
      {children}
    </button>
  )
}

function Multi({ label, icon, options, chosen, onChange }: { label: string; icon: React.ReactNode; options: FacetValue[]; chosen: string[]; onChange: (v: string[]) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            'flex h-7 items-center gap-1 rounded-full border px-2.5 text-small focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-studio-accent',
            chosen.length ? 'border-studio-accent bg-studio-accent-soft' : 'border-studio-border-strong hover:bg-studio-panel-hover',
          )}
        >
          {icon}
          {chosen.length ? `${label}: ${chosen.length === 1 ? chosen[0] : `${chosen.length} chosen`}` : label}
          <ChevronDown aria-hidden className="size-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56">
        {options.length === 0 && <DropdownMenuLabel className="font-normal text-studio-muted">Nothing to pick from here</DropdownMenuLabel>}
        {options.map((o) => (
          <DropdownMenuCheckboxItem key={o.value} checked={chosen.includes(o.value)} onCheckedChange={() => onChange(toggleIn(chosen, o.value))} onSelect={(e) => e.preventDefault()}>
            <span className="flex-1 truncate">{o.value}</span>
            <span className="pl-3 text-[11px] tabular-nums text-studio-muted">{o.count}</span>
          </DropdownMenuCheckboxItem>
        ))}
        {chosen.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onChange([])}>Clear {label.toLowerCase()}</DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function lastDay(y: string, m: string) {
  return new Date(Number(y), Number(m), 0).getDate()
}

/** Lightroom's Library Filter: text, attributes (flag, stars, label, edited), metadata columns with counts. */
export function FilterBar({ value: f, onChange, facets }: Props) {
  const set = (p: Partial<FilterState>) => onChange({ ...f, ...p })
  const n = filterCount(f)
  const dateLabel = f.dateFrom ? (f.dateFrom.slice(0, 7) === f.dateTo?.slice(0, 7) ? f.dateFrom.slice(0, 7) : `${f.dateFrom} → ${f.dateTo ?? '…'}`) : 'Date'
  return (
    <div role="search" aria-label="Filter photos" className="flex flex-wrap items-center gap-1.5">
      <label className="relative">
        <span className="sr-only">Search title, caption, keywords, camera</span>
        <Search aria-hidden className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-studio-muted" />
        <Input value={f.q} onChange={(e) => set({ q: e.target.value })} placeholder="Search" className="h-7 w-44 pl-7" />
      </label>

      <span role="group" aria-label="Flag" className="flex gap-1">
        {([['pick', 'Picks'], ['none', 'Unflagged'], ['reject', 'Rejects']] as const).map(([id, label]) => (
          <Chip key={id} on={f.flags.includes(id)} onClick={() => set({ flags: toggleIn(f.flags, id) })} title={`${label} (${facets?.flag[id] ?? 0})`}>
            {id === 'pick' ? <Flag aria-hidden className="size-3.5" /> : id === 'reject' ? <X aria-hidden className="size-3.5" /> : null}
            {label}
            <span className="text-[11px] opacity-70">{facets?.flag[id] ?? 0}</span>
          </Chip>
        ))}
      </span>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" className={cn('flex h-7 items-center gap-1 rounded-full border px-2.5 text-small', f.ratingMin ? 'border-studio-accent bg-studio-accent-soft' : 'border-studio-border-strong hover:bg-studio-panel-hover')}>
            <Star aria-hidden className="size-3.5" /> {f.ratingMin ? `≥ ${f.ratingMin} stars` : 'Stars'} <ChevronDown aria-hidden className="size-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuRadioGroup value={String(f.ratingMin ?? 0)} onValueChange={(v) => set({ ratingMin: Number(v) || null })}>
            <DropdownMenuRadioItem value="0">Any rating</DropdownMenuRadioItem>
            {[1, 2, 3, 4, 5].map((r) => {
              const count = Object.entries(facets?.rating ?? {}).filter(([k]) => Number(k) >= r).reduce((s, [, c]) => s + c, 0)
              return (
                <DropdownMenuRadioItem key={r} value={String(r)}>
                  <span className="flex-1">{'★'.repeat(r)} and up</span>
                  <span className="pl-3 text-[11px] text-studio-muted">{count}</span>
                </DropdownMenuRadioItem>
              )
            })}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      <span role="group" aria-label="Colour label" className="flex items-center gap-1 rounded-full border border-studio-border-strong px-1.5 py-1">
        {LABELS.map((l) => (
          <button
            key={l.id}
            type="button"
            aria-pressed={f.labels.includes(l.id)}
            aria-label={`${l.name} label (${facets?.label[l.id] ?? 0})`}
            title={`${l.name} (${facets?.label[l.id] ?? 0})`}
            onClick={() => set({ labels: toggleIn(f.labels, l.id) })}
            className={cn('size-4 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-studio-accent', f.labels.includes(l.id) ? 'ring-2 ring-studio-text ring-offset-1 ring-offset-studio-panel' : 'opacity-70 hover:opacity-100')}
            style={{ background: l.swatch }}
          />
        ))}
      </span>

      <Multi label="Camera" icon={<Camera aria-hidden className="size-3.5" />} options={facets?.camera ?? []} chosen={f.cameras} onChange={(cameras) => set({ cameras })} />
      <Multi label="Lens" icon={<Aperture aria-hidden className="size-3.5" />} options={facets?.lens ?? []} chosen={f.lenses} onChange={(lenses) => set({ lenses })} />
      <Multi label="Keyword" icon={<Tag aria-hidden className="size-3.5" />} options={facets?.keyword ?? []} chosen={f.keywords} onChange={(keywords) => set({ keywords })} />

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" className={cn('flex h-7 items-center gap-1 rounded-full border px-2.5 text-small', f.dateFrom ? 'border-studio-accent bg-studio-accent-soft' : 'border-studio-border-strong hover:bg-studio-panel-hover')}>
            <Calendar aria-hidden className="size-3.5" /> {dateLabel} <ChevronDown aria-hidden className="size-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-80 min-w-52">
          <DropdownMenuItem onSelect={() => set({ dateFrom: null, dateTo: null })}>Any date</DropdownMenuItem>
          {(facets?.date ?? []).map((y) => (
            <div key={y.year}>
              <DropdownMenuItem onSelect={() => set({ dateFrom: `${y.year}-01-01`, dateTo: `${y.year}-12-31` })}>
                <span className="flex-1 font-medium">{y.year}</span>
                <span className="text-[11px] text-studio-muted">{y.count}</span>
              </DropdownMenuItem>
              {y.months.map((m) => (
                <DropdownMenuItem key={m.month} className="pl-6" onSelect={() => set({ dateFrom: `${y.year}-${m.month}-01`, dateTo: `${y.year}-${m.month}-${lastDay(y.year, m.month)}` })}>
                  <span className="flex-1">{MONTHS[Number(m.month) - 1]}</span>
                  <span className="text-[11px] text-studio-muted">{m.count}</span>
                </DropdownMenuItem>
              ))}
            </div>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <Chip on={f.edited === true} onClick={() => set({ edited: f.edited === true ? null : true })} title={`Edited (${facets?.edited.yes ?? 0})`}>
        Edited <span className="text-[11px] opacity-70">{facets?.edited.yes ?? 0}</span>
      </Chip>

      {n > 0 && (
        <Button size="sm" variant="ghost" onClick={() => onChange(EMPTY_FILTER)}>
          Clear {n} filter{n === 1 ? '' : 's'}
        </Button>
      )}
    </div>
  )
}
