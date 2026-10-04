import { Link, useParams } from 'react-router'
import { Clapperboard, ListOrdered, PanelRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip } from '@/components/ui/tooltip'
import { useBreakpoint } from '@/hooks/useBreakpoint'
import { useJobs } from '@/hooks/useJobs'
import { STAGES } from '@/lib/stages'
import { cn } from '@/lib/utils'
import { useUi } from '@/stores/ui'
import { ConnectionStatus } from './ConnectionStatus'
import { ProjectSwitcher } from './ProjectSwitcher'
import { UserMenu } from './UserMenu'

function QueueButton({ iconOnly }: { iconOnly?: boolean }) {
  const setOpen = useUi((s) => s.setQueueOpen)
  const { data } = useJobs()
  const running = data?.filter((j) => j.status === 'running').length ?? 0
  const waiting = data?.filter((j) => j.status === 'queued').length ?? 0
  return (
    <Button
      size="sm"
      variant="secondary"
      onClick={() => setOpen(true)}
      aria-label={`Queue: ${running} running, ${waiting} waiting`}
      className={cn(iconOnly && 'px-2')}
    >
      <ListOrdered aria-hidden />
      {!iconOnly && 'Queue'}
      {running + waiting > 0 && (
        <span className="rounded-full bg-studio-accent px-1.5 font-mono text-[11px] leading-[18px] text-studio-accent-fg">
          {running + waiting}
        </span>
      )}
    </Button>
  )
}

function StageNav({ iconOnly, fill }: { iconOnly: boolean; fill?: boolean }) {
  return (
    <nav aria-label="Production stages" className={cn('min-w-0', fill ? 'w-full' : 'mx-auto')}>
      <TabsList aria-label="Production stages" className={cn(fill && 'justify-between')}>
        {STAGES.map((s, i) => {
          const trigger = (
            <TabsTrigger key={s.id} value={s.id} aria-label={iconOnly ? s.label : undefined} className={cn(iconOnly && 'px-2')}>
              <s.icon aria-hidden />
              {!iconOnly && (
                <>
                  <span className="hidden font-mono text-small opacity-60 2xl:inline">{i + 1}</span>
                  {s.label}
                </>
              )}
            </TabsTrigger>
          )
          return iconOnly ? (
            <Tooltip key={s.id} content={`${i + 1}. ${s.label}`} side="bottom">
              {trigger}
            </Tooltip>
          ) : (
            trigger
          )
        })}
        {/* TODO: show ✓ / ⚠ per stage once the backend exposes stage completeness */}
      </TabsList>
    </nav>
  )
}

export function TopBar() {
  const { projectId } = useParams()
  const bp = useBreakpoint()
  const inspectorOpen = useUi((s) => s.inspectorOpen)
  const setInspectorOpen = useUi((s) => s.setInspectorOpen)
  const mobile = bp === 'mobile'

  return (
    <header
      data-f6-region
      tabIndex={-1}
      className="glass relative z-30 shrink-0 border-b border-studio-border focus-visible:outline-none"
    >
      <div className="flex h-14 items-center gap-2 px-3 md:gap-3">
        <div className="flex min-w-0 items-center gap-2 max-md:flex-1">
          <Link
            to="/projects"
            className="flex size-8 shrink-0 items-center justify-center rounded-[6px] bg-studio-gold text-studio-darkroom"
            aria-label="Mix AI Cinema Studio — all projects"
          >
            <Clapperboard aria-hidden className="size-4" />
          </Link>
          {projectId ? (
            <ProjectSwitcher projectId={projectId} />
          ) : (
            <span className="font-display text-panel font-semibold">Mix AI Cinema Studio</span>
          )}
        </div>

        {projectId && !mobile && <StageNav iconOnly={bp === 'compact'} />}

        <div className="ml-auto flex shrink-0 items-center gap-1.5 md:gap-2">
          <ConnectionStatus compact={bp !== 'wide'} />
          {projectId && bp === 'compact' && (
            <Tooltip content={inspectorOpen ? 'Hide Inspector' : 'Show Inspector'}>
              <Button
                size="icon-sm"
                variant={inspectorOpen ? 'primary' : 'secondary'}
                aria-label="Inspector"
                aria-pressed={inspectorOpen}
                onClick={() => setInspectorOpen(!inspectorOpen)}
              >
                <PanelRight aria-hidden />
              </Button>
            </Tooltip>
          )}
          <QueueButton iconOnly={mobile} />
          <UserMenu />
        </div>
      </div>
      {projectId && mobile && (
        <div className="flex h-11 items-center border-t border-studio-border px-2">
          <StageNav iconOnly fill />
        </div>
      )}
    </header>
  )
}
