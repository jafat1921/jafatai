import { useRef, useState } from 'react'
import { Link, useLocation } from 'react-router'
import { Clapperboard } from 'lucide-react'
import { Tooltip } from '@/components/ui/tooltip'
import { useConnections } from '@/hooks/useConnections'
import { useRunningCount } from '@/hooks/useStudio'
import { activeRail, RAIL_ITEMS, SETTINGS_ITEM, type RailId, type RailItem } from '@/lib/nav'
import { cn } from '@/lib/utils'
import { StatusDot } from './ConnectionStatus'
import { MegaMenu } from './MegaMenu'
import { UserMenu } from './UserMenu'
import { useMegaMenu } from './useMegaMenu'

const ITEM =
  'relative flex w-14 flex-col items-center gap-1 rounded-[6px] py-1.5 text-studio-muted transition-colors duration-150 hover:bg-studio-panel-hover hover:text-studio-text'
const ACTIVE = 'bg-studio-accent-soft text-studio-text font-semibold'

function Indicator({ on }: { on: boolean }) {
  // gold bar on the rail's left edge; shape, not colour alone, marks the current section
  return on ? <span aria-hidden className="absolute -left-2 top-2 bottom-2 w-[3px] rounded-r bg-studio-gold" /> : null
}

function Face({ item, badge }: { item: RailItem; badge?: number }) {
  return (
    <>
      <span className="relative">
        <item.icon aria-hidden className="size-5" />
        {!!badge && (
          <span
            aria-hidden
            className="absolute -right-2.5 -top-1.5 min-w-4 rounded-full bg-studio-accent px-1 text-center font-mono text-[11px] leading-4 text-studio-accent-fg"
          >
            {badge}
          </span>
        )}
      </span>
      <span aria-hidden className="text-small leading-none">
        {item.label}
      </span>
    </>
  )
}

export function Rail() {
  const { pathname } = useLocation()
  const active = activeRail(pathname)
  const root = useRef<HTMLElement>(null)
  const triggers = useRef(new Map<RailId, HTMLButtonElement>())
  const menu = useMegaMenu<RailId>(root)
  const { running } = useRunningCount()
  const conn = useConnections()
  // set on pointerdown so the click handler knows mouse vs touch vs keyboard
  const [pointer, setPointer] = useState<string | null>(null)

  const closeMenu = (returnFocus: boolean) => {
    const id = menu.open?.id
    menu.close()
    if (returnFocus && id) triggers.current.get(id)?.focus()
  }

  return (
    <nav
      ref={root}
      aria-label="Main"
      data-f6-region
      tabIndex={-1}
      className="relative z-40 flex w-[72px] shrink-0 flex-col items-center gap-1 border-r border-studio-border bg-studio-panel py-2 focus-visible:outline-none"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && menu.open) closeMenu(true)
      }}
    >
      <Link
        to="/"
        aria-label="Mix AI Cinema Studio, home"
        className="mb-2 flex size-9 items-center justify-center rounded-[6px] bg-studio-gold text-studio-darkroom shadow-card"
      >
        <Clapperboard aria-hidden className="size-4" />
      </Link>

      <ul className="flex flex-col items-center gap-1">
        {RAIL_ITEMS.map((item) => {
          const on = active === item.id
          if (!item.menu) {
            const badge = item.id === 'queue' ? running : undefined
            return (
              <li key={item.id}>
                <Link
                  to={item.to}
                  aria-current={on ? 'page' : undefined}
                  aria-label={item.id === 'queue' ? `Queue, ${running} running` : item.label}
                  className={cn(ITEM, on && ACTIVE)}
                  onPointerEnter={() => menu.open && menu.hoverLeave()}
                >
                  <Indicator on={on} />
                  <Face item={item} badge={badge} />
                </Link>
              </li>
            )
          }
          const isOpen = menu.open?.id === item.id
          const panelId = `megamenu-${item.id}`
          return (
            <li key={item.id}>
              <button
                ref={(el) => {
                  if (el) triggers.current.set(item.id, el)
                  else triggers.current.delete(item.id)
                }}
                id={`rail-${item.id}`}
                type="button"
                aria-expanded={isOpen}
                aria-controls={isOpen ? panelId : undefined}
                aria-current={on ? 'true' : undefined}
                aria-label={item.label}
                className={cn(ITEM, on && ACTIVE, isOpen && 'bg-studio-panel-hover text-studio-text')}
                onPointerDown={(e) => setPointer(e.pointerType)}
                onPointerEnter={(e) => e.pointerType === 'mouse' && menu.hoverEnter(item.id)}
                onPointerLeave={(e) => e.pointerType === 'mouse' && menu.hoverLeave()}
                onClick={(e) => {
                  // detail 0 = Enter/Space; touch toggles; a mouse click keeps a hover-opened menu open
                  const keyboard = e.detail === 0
                  if (keyboard || pointer !== 'mouse') menu.toggle(item.id, keyboard)
                  else menu.show(item.id, false)
                  setPointer(null)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
                    e.preventDefault()
                    menu.show(item.id, true)
                  }
                }}
              >
                <Indicator on={on} />
                <Face item={item} />
              </button>
              {isOpen && (
                <MegaMenu
                  // remount per open so keyboard focus lands on the first item again
                  key={`${item.id}-${menu.open!.keyboard}`}
                  id={panelId}
                  section={item.menu}
                  anchorId={`rail-${item.id}`}
                  keyboard={menu.open!.keyboard}
                  onPick={() => menu.close()}
                  onClose={closeMenu}
                  onPointerEnter={menu.cancelClose}
                  onPointerLeave={(e) => e.pointerType === 'mouse' && menu.hoverLeave()}
                />
              )}
            </li>
          )
        })}
      </ul>

      <div className="mt-auto flex flex-col items-center gap-1">
        <Tooltip
          side="right"
          content={
            <span className="block">
              ComfyUI: {conn.comfy === 'ok' ? 'connected' : conn.comfy === 'down' ? 'offline' : 'checking'} — {conn.comfyDetail}
              <br />
              Ollama: {conn.llm === 'ok' ? 'connected' : conn.llm === 'down' ? 'offline' : 'checking'} — {conn.llmDetail}
              {conn.mock && (
                <>
                  <br />
                  Mock renderer in use
                </>
              )}
            </span>
          }
        >
          <Link
            to={SETTINGS_ITEM.to}
            aria-current={active === 'settings' ? 'page' : undefined}
            aria-label={`Settings. ${conn.summary}`}
            className={cn(ITEM, active === 'settings' && ACTIVE)}
            onPointerEnter={() => menu.open && menu.hoverLeave()}
          >
            <Indicator on={active === 'settings'} />
            <span className="relative">
              <SETTINGS_ITEM.icon aria-hidden className="size-5" />
              <StatusDot state={conn.overall} className="absolute -right-1 -top-0.5 size-2.5 ring-2 ring-studio-panel" />
            </span>
            <span aria-hidden className="text-small leading-none">
              Settings
            </span>
          </Link>
        </Tooltip>
        <UserMenu rail />
      </div>
    </nav>
  )
}
