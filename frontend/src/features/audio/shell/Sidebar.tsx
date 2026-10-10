import { Link, useLocation } from 'react-router'
import { Collapsible } from 'radix-ui'
import { ChevronRight, PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { Tooltip } from '@/components/ui/tooltip'
import { modKey } from '@/lib/keyboard'
import { cn } from '@/lib/utils'
import { AUDIO_GROUPS, isActive, shortcutOf, type AudioPage } from './pages'

interface Props {
  // the icon rail: labels go into tooltips, groups can't fold
  rail: boolean
  // the rail toggle is hidden where the width decides (compact screens, the phone sheet)
  onRail?: (rail: boolean) => void
  groups: Record<string, boolean>
  onGroup: (id: string, open: boolean) => void
  onNavigate?: () => void
}

const ITEM = 'relative flex items-center gap-2 rounded-[4px] text-small transition-colors duration-150'

function Entry({ page, rail, onNavigate }: { page: AudioPage; rail: boolean; onNavigate?: () => void }) {
  const { pathname } = useLocation()
  const on = isActive(page, pathname)
  const n = shortcutOf(page)
  const face = (
    <>
      {/* a bar as well as the tint, so the current page isn't marked by colour alone */}
      {on && <span aria-hidden className="absolute inset-y-1 left-0 w-[3px] rounded-r bg-studio-gold" />}
      <page.icon aria-hidden className="size-4 shrink-0" />
      {!rail && <span className="min-w-0 flex-1 truncate">{page.label}</span>}
      {!rail && page.soon && <span className="rounded-full border border-studio-border px-1.5 text-[10px] uppercase tracking-wide text-studio-faint">soon</span>}
      {!rail && n && <span aria-hidden className="font-mono text-[10px] text-studio-faint">{n}</span>}
    </>
  )
  const size = rail ? 'size-10 justify-center' : 'h-8 px-2.5'
  const label = page.soon ? `${page.label}, coming soon` : page.label
  const el = page.soon ? (
    // listed so people know it's coming; not a link anywhere yet
    <span role="link" aria-disabled="true" aria-label={rail ? label : undefined} className={cn(ITEM, size, 'cursor-not-allowed text-studio-faint')}>
      {face}
      {!rail && <span className="sr-only">, coming soon</span>}
    </span>
  ) : (
    <Link
      to={page.to}
      onClick={onNavigate}
      aria-current={on ? 'page' : undefined}
      aria-label={rail ? page.label : undefined}
      aria-keyshortcuts={n ? `Control+${n}` : undefined}
      className={cn(ITEM, size, on ? 'bg-studio-accent-soft font-medium text-studio-text' : 'text-studio-muted hover:bg-studio-panel-hover hover:text-studio-text')}
    >
      {face}
    </Link>
  )
  if (!rail) return el
  return (
    <Tooltip side="right" content={n ? `${label} · ${modKey}+${n}` : label}>
      {el}
    </Tooltip>
  )
}

/** The Audio room's own navigation, grouped like the plan: Create, Voice, Story, Edit, Tools, Library. */
export function Sidebar({ rail, onRail, groups, onGroup, onNavigate }: Props) {
  return (
    <nav aria-label="Audio Studio" className={cn('flex min-h-0 flex-col gap-0.5 overflow-y-auto py-2', rail ? 'items-center px-1' : 'px-2')}>
      {onRail && (
        <button
          type="button"
          onClick={() => onRail(!rail)}
          aria-label={rail ? 'Expand the audio sidebar' : 'Collapse the audio sidebar to icons'}
          aria-expanded={!rail}
          title={rail ? 'Expand' : 'Collapse'}
          className={cn('mb-1 flex items-center gap-2 rounded-[4px] text-small text-studio-muted hover:bg-studio-panel-hover hover:text-studio-text', rail ? 'size-10 justify-center' : 'h-7 self-end px-1.5')}
        >
          {rail ? <PanelLeftOpen aria-hidden className="size-4" /> : <PanelLeftClose aria-hidden className="size-4" />}
        </button>
      )}
      {AUDIO_GROUPS.map((g, i) =>
        rail ? (
          <ul key={g.id} aria-label={g.label} className={cn('flex flex-col items-center gap-0.5', i > 0 && 'mt-1 border-t border-studio-border pt-1')}>
            {g.pages.map((p) => (
              <li key={p.id}>
                <Entry page={p} rail onNavigate={onNavigate} />
              </li>
            ))}
          </ul>
        ) : (
          <Collapsible.Root key={g.id} open={groups[g.id] ?? true} onOpenChange={(o) => onGroup(g.id, o)} className={cn(i > 0 && 'border-t border-studio-border pt-1')}>
            <Collapsible.Trigger className="group flex w-full items-center gap-1 rounded-[4px] px-1 py-1 text-left hover:bg-studio-panel-hover">
              <ChevronRight aria-hidden className="size-3 text-studio-faint transition-transform duration-150 group-data-[state=open]:rotate-90" />
              <span className="section-label">{g.label}</span>
            </Collapsible.Trigger>
            <Collapsible.Content>
              <ul aria-label={g.label} className="flex flex-col gap-0.5 pb-1">
                {g.pages.map((p) => (
                  <li key={p.id}>
                    <Entry page={p} rail={false} onNavigate={onNavigate} />
                  </li>
                ))}
              </ul>
            </Collapsible.Content>
          </Collapsible.Root>
        ),
      )}
    </nav>
  )
}
