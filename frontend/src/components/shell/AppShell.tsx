import { Outlet, useNavigate, useParams } from 'react-router'
import { Tabs } from '@/components/ui/tabs'
import { useEventStream } from '@/hooks/useEventStream'
import { useF6Cycle } from '@/hooks/useF6Cycle'
import { isStage } from '@/lib/stages'
import { useUi } from '@/stores/ui'
import { TopBar } from './TopBar'
import { QueueDrawer } from './QueueDrawer'

function LiveAnnouncer() {
  const { text, n } = useUi((s) => s.announcement)
  return (
    <div aria-live="polite" aria-atomic="true" className="sr-only">
      {/* key change makes screen readers repeat identical messages */}
      <span key={n}>{text}</span>
    </div>
  )
}

export function AppShell() {
  const { projectId, stage } = useParams()
  const navigate = useNavigate()
  useEventStream(true)
  useF6Cycle()

  // The Tabs root spans the top bar (tab list) and the workspace (tab panels) so
  // aria-controls/labelledby wire up; the URL is the source of truth.
  return (
    <Tabs
      value={isStage(stage) ? stage : ''}
      onValueChange={(v) => projectId && navigate(`/projects/${projectId}/${v}`)}
      activationMode="manual"
      className="flex h-full flex-col"
    >
      <TopBar />
      <div className="min-h-0 flex-1">
        <Outlet />
      </div>
      <QueueDrawer />
      <LiveAnnouncer />
    </Tabs>
  )
}
