import { useId, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import { useProjects } from '@/hooks/useProjects'
import { qk } from '@/hooks/keys'
import { api } from '@/lib/api'
import { SELECT } from '../voice/AddVoiceDialog'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  defaultProject: string | null
  onImport: (body: { project_id: string; scene_ids?: string[]; include_action: boolean }) => void
  pending: boolean
  error: string | null
}

export function ImportProjectDialog({ open, onOpenChange, defaultProject, onImport, pending, error }: Props) {
  const uid = useId()
  const projects = useProjects()
  const [projectId, setProjectId] = useState(defaultProject ?? '')
  // null: every scene; a set once the user unticks one
  const [picked, setPicked] = useState<Set<string> | null>(null)
  const [action, setAction] = useState(false)
  const scenes = useQuery({
    queryKey: qk.scenes(projectId),
    queryFn: () => api.scenes.list(projectId),
    enabled: open && !!projectId,
    select: (s) => [...s].sort((a, b) => a.order - b.order),
  })
  const list = scenes.data ?? []
  const chosen = picked ?? new Set(list.map((s) => s.id))
  const toggle = (id: string) => {
    const next = new Set(chosen)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setPicked(next)
  }
  const pickProject = (id: string) => {
    setProjectId(id)
    setPicked(null)
  }
  const all = picked === null || chosen.size === list.length

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Import from a project</DialogTitle>
          <DialogDescription>Character cues become the cast and their dialogue becomes lines, in scene order.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <label className="flex flex-col gap-1 text-small">
            <span className="section-label">Film project</span>
            <select value={projectId} onChange={(e) => pickProject(e.target.value)} className={SELECT}>
              <option value="">Choose a project…</option>
              {(projects.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
          </label>
          {projectId && (
            <fieldset className="flex flex-col gap-1.5">
              <legend className="section-label mb-1.5">Scenes</legend>
              {scenes.isPending ? (
                <p className="text-small text-studio-muted">Loading scenes…</p>
              ) : list.length === 0 ? (
                <p className="text-small text-studio-muted">This project has no scenes yet.</p>
              ) : (
                <ul className="flex max-h-64 flex-col gap-0.5 overflow-y-auto rounded-[6px] border border-studio-border bg-studio-raised p-1">
                  {list.map((s, i) => (
                    <li key={s.id}>
                      <label className="flex items-start gap-2 rounded-[4px] px-2 py-1 text-small hover:bg-studio-panel-hover">
                        <input type="checkbox" checked={chosen.has(s.id)} onChange={() => toggle(s.id)} className="mt-0.5 accent-studio-accent" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">
                            {i + 1}. {s.heading || 'Untitled scene'}
                          </span>
                          {!s.script_text.trim() && <span className="text-[11px] text-studio-muted">No script yet</span>}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </fieldset>
          )}
          <div className="flex items-center gap-2">
            <Switch id={`${uid}-action`} checked={action} onCheckedChange={setAction} />
            <label htmlFor={`${uid}-action`} className="text-small">
              Include action lines, read by the narrator
            </label>
          </div>
        </div>
        {error && (
          <p role="alert" className="mt-3 text-small text-studio-danger">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={!projectId || list.length === 0 || chosen.size === 0}
            loading={pending}
            onClick={() => onImport({ project_id: projectId, scene_ids: all ? undefined : [...chosen], include_action: action })}
          >
            Import {all ? 'all scenes' : `${chosen.size} scene${chosen.size === 1 ? '' : 's'}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
