import { useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { Clapperboard, Home, ImageIcon, ListOrdered, LogOut, Menu, Settings, X } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { useLogout, useMe } from '@/hooks/useAuth'
import { useConnections } from '@/hooks/useConnections'
import { useRunningCount } from '@/hooks/useStudio'
import { activeRail, MENUS, type MenuSection } from '@/lib/nav'
import { useQuillCursor } from '@/lib/quill'
import { cn } from '@/lib/utils'
import { StatusDot } from './ConnectionStatus'
import { FeatureLink, ModelLink } from './MegaMenu'

type Sheet = 'image' | 'video' | 'more' | null

function SectionList({ section, onPick }: { section: MenuSection; onPick: () => void }) {
  return (
    <>
      <h3 className="section-label px-2 pt-2">{section.title} · features</h3>
      <ul>
        {section.features.map((f) => (
          <li key={f.id}>
            <FeatureLink f={f} onPick={onPick} />
          </li>
        ))}
      </ul>
      {section.models.length > 0 && (
        <>
          <h3 className="section-label px-2 pt-3">Models</h3>
          <ul>
            {section.models.map((m) => (
              <li key={m.id}>
                <ModelLink m={m} onPick={onPick} />
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  )
}

function MoreSheet({ onPick }: { onPick: () => void }) {
  const { data: me } = useMe()
  const logout = useLogout()
  const navigate = useNavigate()
  const [quill, setQuill] = useQuillCursor()
  const conn = useConnections()
  return (
    <>
      <SectionList section={MENUS.assets} onPick={onPick} />
      <SectionList section={MENUS.upscale} onPick={onPick} />
      <h3 className="section-label px-2 pt-3">System &amp; account</h3>
      <Link to="/settings" onClick={onPick} className="flex items-center gap-3 rounded-[6px] p-2 hover:bg-studio-panel-hover">
        <Settings aria-hidden className="size-4 text-studio-accent" />
        <span className="flex-1 text-body">Settings</span>
        <StatusDot state={conn.overall} />
        <span className="text-small text-studio-muted">{conn.label}</span>
      </Link>
      <label className="flex items-center gap-3 rounded-[6px] p-2 text-body">
        <span className="flex-1">Quill cursor</span>
        <Switch checked={quill} onCheckedChange={setQuill} aria-label="Quill cursor" />
      </label>
      <button
        type="button"
        className="flex w-full items-center gap-3 rounded-[6px] p-2 text-left text-body hover:bg-studio-panel-hover"
        onClick={() => logout.mutate(undefined, { onSettled: () => navigate('/login', { replace: true }) })}
      >
        <LogOut aria-hidden className="size-4 text-studio-muted" />
        Log out {me?.email && <span className="truncate text-small text-studio-muted">{me.email}</span>}
      </button>
    </>
  )
}

const TAB = 'relative flex min-h-12 flex-1 flex-col items-center justify-center gap-0.5 text-small text-studio-muted'

/** Phone navigation (navigation.md rev 2): Home · Image · Video · Queue · More, menus as bottom sheets. */
export function BottomBar() {
  const { pathname } = useLocation()
  const active = activeRail(pathname)
  const [sheet, setSheet] = useState<Sheet>(null)
  const { running } = useRunningCount()
  const close = () => setSheet(null)
  const on = (id: string) => (id === 'more' ? ['assets', 'upscale', 'settings'].includes(active ?? '') : active === id)

  const button = (id: 'image' | 'video' | 'more', label: string, Icon: typeof Home) => (
    <button
      type="button"
      aria-expanded={sheet === id}
      aria-current={on(id) ? 'true' : undefined}
      onClick={() => setSheet(sheet === id ? null : id)}
      className={cn(TAB, on(id) && 'font-semibold text-studio-text')}
    >
      {on(id) && <span aria-hidden className="absolute inset-x-4 top-0 h-[3px] rounded-b bg-studio-gold" />}
      <Icon aria-hidden className="size-5" />
      {label}
    </button>
  )
  const link = (id: 'home' | 'queue', to: string, label: string, Icon: typeof Home) => (
    <Link to={to} aria-current={on(id) ? 'page' : undefined} className={cn(TAB, on(id) && 'font-semibold text-studio-text')}>
      {on(id) && <span aria-hidden className="absolute inset-x-4 top-0 h-[3px] rounded-b bg-studio-gold" />}
      <span className="relative">
        <Icon aria-hidden className="size-5" />
        {id === 'queue' && running > 0 && (
          <span className="absolute -right-2.5 -top-1.5 min-w-4 rounded-full bg-studio-accent px-1 text-center font-mono text-[11px] leading-4 text-studio-accent-fg">
            {running}
            <span className="sr-only"> running</span>
          </span>
        )}
      </span>
      {label}
    </Link>
  )

  return (
    <>
      <nav aria-label="Main" className="glass flex shrink-0 border-t border-studio-border pb-[env(safe-area-inset-bottom)]">
        {link('home', '/', 'Home', Home)}
        {button('image', 'Image', ImageIcon)}
        {button('video', 'Video', Clapperboard)}
        {link('queue', '/queue', 'Queue', ListOrdered)}
        {button('more', 'More', Menu)}
      </nav>
      <DialogPrimitive.Root open={sheet !== null} onOpenChange={(o) => !o && close()}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-[rgb(42_28_15/0.3)] motion-safe:animate-fade-in" />
          <DialogPrimitive.Content
            aria-describedby={undefined}
            className="fixed inset-x-0 bottom-0 z-50 max-h-[80vh] overflow-y-auto rounded-t-[12px] border-t border-studio-gold/70 bg-studio-raised p-3 pb-[calc(12px+env(safe-area-inset-bottom))] shadow-modal paper-fine"
          >
            <div className="mb-1 flex items-center justify-between">
              <DialogPrimitive.Title className="font-display text-title font-semibold">
                {sheet === 'image' ? 'Image Tools' : sheet === 'video' ? 'Video Tools' : 'More'}
              </DialogPrimitive.Title>
              <DialogPrimitive.Close className="rounded-[6px] p-2 text-studio-muted hover:bg-studio-panel-hover" aria-label="Close">
                <X className="size-4" />
              </DialogPrimitive.Close>
            </div>
            {sheet === 'image' && <SectionList section={MENUS.image} onPick={close} />}
            {sheet === 'video' && <SectionList section={MENUS.video} onPick={close} />}
            {sheet === 'more' && <MoreSheet onPick={close} />}
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </>
  )
}
