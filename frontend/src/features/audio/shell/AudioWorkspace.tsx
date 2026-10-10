import { useEffect, useState } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router'
import { Menu } from 'lucide-react'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { useBreakpoint } from '@/hooks/useBreakpoint'
import { isTypingTarget } from '@/lib/keyboard'
import { AUDIO_GROUPS, isActive, NUMBERED } from './pages'
import { ShortcutSheet } from './ShortcutSheet'
import { Sidebar } from './Sidebar'
import { StatusStrip } from './StatusStrip'
import { TransportBar } from './TransportBar'

const KEY = 'mixai.audio.sidebar'

interface Prefs {
  rail: boolean
  groups: Record<string, boolean>
}

function readPrefs(): Prefs {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Prefs> | null
    return { rail: !!v?.rail, groups: v?.groups ?? {} }
  } catch {
    return { rail: false, groups: {} }
  }
}

function writePrefs(p: Prefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p))
  } catch {
    /* private mode */
  }
}

/**
 * The frame around every /audio page, inside the app's own rail and top bar: the room's sidebar on
 * the left, the page, then the status strip and the one transport along the bottom.
 */
export function AudioWorkspace() {
  const bp = useBreakpoint()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const [prefs, setPrefs] = useState(readPrefs)
  const [sheet, setSheet] = useState(false)
  const [help, setHelp] = useState(false)
  const update = (p: Prefs) => {
    setPrefs(p)
    writePrefs(p)
  }
  const phone = bp === 'mobile'
  // compact screens get the icon rail whatever was chosen on a wide one
  const rail = bp === 'compact' || prefs.rail
  const current = AUDIO_GROUPS.flatMap((g) => g.pages).find((p) => isActive(p, pathname))

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isTypingTarget(e.target)) return
      if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault()
        setHelp(true)
        return
      }
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && /^[1-9]$/.test(e.key)) {
        const page = NUMBERED[Number(e.key) - 1]
        if (!page) return
        // the browser would switch tabs
        e.preventDefault()
        navigate(page.to)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [navigate])

  const sidebar = (
    <Sidebar
      rail={!phone && rail}
      onRail={phone || bp === 'compact' ? undefined : (r) => update({ ...prefs, rail: r })}
      groups={prefs.groups}
      onGroup={(id, open) => update({ ...prefs, groups: { ...prefs.groups, [id]: open } })}
      onNavigate={phone ? () => setSheet(false) : undefined}
    />
  )

  return (
    // everything stays inside the screen: only the page area (and a long sidebar) scroll, never the window
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden" data-audio-workspace>
      <div className="flex min-h-0 flex-1">
        {!phone && <aside className={`flex min-h-0 shrink-0 flex-col overflow-hidden border-r border-studio-border bg-studio-panel ${rail ? 'w-14' : 'w-52'}`}>{sidebar}</aside>}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {phone && (
            <div className="flex h-10 shrink-0 items-center gap-2 border-b border-studio-border bg-studio-panel px-2">
              <button
                type="button"
                onClick={() => setSheet(true)}
                aria-label="Audio pages"
                aria-haspopup="dialog"
                className="flex h-8 items-center gap-1.5 rounded-[4px] px-2 text-small hover:bg-studio-panel-hover"
              >
                <Menu aria-hidden className="size-4" />
                {current?.label ?? 'Audio'}
              </button>
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto">
            <Outlet />
          </div>
        </div>
      </div>
      <StatusStrip onShortcuts={() => setHelp(true)} />
      <TransportBar />
      {phone && (
        <Sheet open={sheet} onOpenChange={setSheet}>
          <SheetContent className="left-0 right-auto w-64 border-l-0 border-r pt-10">
            <SheetTitle className="sr-only">Audio pages</SheetTitle>
            {sidebar}
          </SheetContent>
        </Sheet>
      )}
      <ShortcutSheet open={help} onOpenChange={setHelp} />
    </div>
  )
}
