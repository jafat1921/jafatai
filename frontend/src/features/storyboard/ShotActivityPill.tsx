import { useEffect, useState } from 'react'
import { StatusPill } from '@/components/studio/status-pill'
import { useJobs } from '@/hooks/useJobs'
import type { Shot } from '@/lib/types'
import { isFrameKind, shotActivity } from './shotList'

/** Live pill for a shot card (queued · 42% · ETA · failed); shows `fallback` when nothing is happening. */
export function ShotActivityPill({ shot, what, fallback }: { shot: Shot; what: 'frames' | 'takes'; fallback?: React.ReactNode }) {
  const { data: jobs } = useJobs()
  const items = (shot.activity ?? []).filter((a) => (what === 'frames' ? isFrameKind(a.kind) : a.kind === 'take'))
  const busy = items.some((a) => a.status !== 'failed')
  const [now, setNow] = useState(() => Date.now())
  // the ETA counts down between job events
  useEffect(() => {
    if (!busy) return
    const t = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(t)
  }, [busy])
  const view = shotActivity(items, jobs, now)
  if (!view) return <>{fallback}</>
  return (
    <span role="status" aria-live="polite">
      <StatusPill status={view} />
    </span>
  )
}
