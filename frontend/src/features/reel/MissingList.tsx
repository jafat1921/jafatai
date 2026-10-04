import { Link } from 'react-router'
import { CircleDashed } from 'lucide-react'
import type { Reel, Shot } from '@/lib/types'
import { plural } from '@/lib/utils'

interface Props {
  missing: Reel['missing']
  projectId: string
  shotFor: (id: string) => { shot: Shot; label: string } | undefined
  onOpen: (shot: Shot) => void
}

/** Shots that have no approved take yet, each linking to its row in Render. */
export function MissingList({ missing, projectId, shotFor, onOpen }: Props) {
  if (!missing.length) return null
  return (
    <section
      aria-labelledby="reel-missing"
      className="rounded-[6px] border border-studio-warning/40 bg-studio-warning/5 p-3"
    >
      <h2 id="reel-missing" className="mb-1 flex items-center gap-1.5 text-heading font-semibold text-studio-warning">
        <CircleDashed aria-hidden className="size-4" />
        {plural(missing.length, 'shot')} without an approved take
      </h2>
      <p className="mb-2 text-small text-studio-muted">They're left out of the film until a take is approved in Render.</p>
      <ul className="flex flex-col gap-1">
        {missing.map((m) => {
          const found = shotFor(m.shot_id)
          const label = found ? `Shot ${found.label}` : 'A shot'
          return (
            <li key={m.shot_id} className="flex flex-wrap items-baseline gap-x-2 text-small">
              <Link
                to={`/projects/${projectId}/render`}
                onClick={() => found && onOpen(found.shot)}
                className="font-medium text-studio-accent-hover underline underline-offset-2"
              >
                {label}: open in Render
              </Link>
              <span className="min-w-0 truncate text-studio-muted">
                {found?.shot.description || m.reason}
              </span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
