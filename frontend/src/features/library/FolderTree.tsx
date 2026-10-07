import { useState } from 'react'
import { ChevronRight, Folder as FolderIcon, FolderOpen, FolderPlus, Library, MoreHorizontal, Pencil, Trash2 } from 'lucide-react'
import { ConfirmDialog } from '@/components/ui/alert-dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { childrenOf, isAncestor } from '@/lib/folders'
import { DRAG_MIME } from '@/lib/selection'
import type { Folder } from '@/lib/types'
import { cn } from '@/lib/utils'

interface Props {
  folders: Folder[]
  current: string | null
  rootLabel: string
  onOpen: (id: string | null) => void
  onDropRefs: (folderId: string | null, refs: string[]) => void
  onCreate: (name: string, parentId: string | null) => void
  onRename: (id: string, name: string) => void
  onDelete: (folder: Folder) => void
}

const readRefs = (e: React.DragEvent): string[] | null => {
  try {
    const raw = e.dataTransfer.getData(DRAG_MIME)
    const refs = raw ? JSON.parse(raw) : null
    return Array.isArray(refs) ? refs.filter((r) => typeof r === 'string') : null
  } catch {
    return null
  }
}

function NameForm({ initial, label, onDone }: { initial: string; label: string; onDone: (name: string | null) => void }) {
  const [name, setName] = useState(initial)
  return (
    <form
      className="flex items-center gap-1 py-0.5 pl-6"
      onSubmit={(e) => {
        e.preventDefault()
        onDone(name.trim() || null)
      }}
    >
      <input
        autoFocus
        aria-label={label}
        value={name}
        maxLength={120}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), onDone(null))}
        onBlur={() => onDone(name.trim() && name.trim() !== initial ? name.trim() : null)}
        className="h-7 min-w-0 flex-1 rounded-[4px] border border-studio-accent bg-studio-raised px-1.5 text-small"
      />
    </form>
  )
}

/** The Library's left pane: folders you can open, drop tiles onto, create, rename and delete. */
export function FolderTree({ folders, current, rootLabel, onOpen, onDropRefs, onCreate, onRename, onDelete }: Props) {
  // explicit open/closed per folder; otherwise the path to the current folder is open
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [over, setOver] = useState<string | null | undefined>(undefined)
  const [editing, setEditing] = useState<{ mode: 'new' | 'rename'; id: string | null } | null>(null)
  const [deleting, setDeleting] = useState<Folder | null>(null)

  const dropProps = (id: string | null) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes(DRAG_MIME)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      setOver(id)
    },
    onDragLeave: () => setOver(undefined),
    onDrop: (e: React.DragEvent) => {
      const refs = readRefs(e)
      setOver(undefined)
      if (!refs?.length) return
      e.preventDefault()
      onDropRefs(id, refs)
    },
  })

  const row = (active: boolean, target: boolean) =>
    cn(
      'flex min-w-0 flex-1 items-center gap-1.5 rounded-[6px] px-1.5 py-1 text-left text-small transition-colors duration-150',
      active ? 'bg-studio-accent-soft font-medium text-studio-text' : 'text-studio-muted hover:bg-studio-panel-hover hover:text-studio-text',
      target && 'ring-2 ring-studio-accent',
    )

  const node = (f: Folder, depth: number): React.ReactNode => {
    const kids = childrenOf(folders, f.id)
    const expanded = open[f.id] ?? (current === f.id || (current != null && isAncestor(folders, f.id, current)))
    if (editing?.mode === 'rename' && editing.id === f.id) {
      return (
        <li key={f.id} style={{ paddingLeft: depth * 12 }}>
          <NameForm
            initial={f.name}
            label={`Rename ${f.name}`}
            onDone={(name) => {
              setEditing(null)
              if (name) onRename(f.id, name)
            }}
          />
        </li>
      )
    }
    return (
      <li key={f.id}>
        <div className="group/folder flex items-center gap-0.5" style={{ paddingLeft: depth * 12 }}>
          <button
            type="button"
            aria-label={expanded ? `Collapse ${f.name}` : `Expand ${f.name}`}
            aria-expanded={expanded}
            onClick={() => setOpen((s) => ({ ...s, [f.id]: !expanded }))}
            className={cn('flex size-5 shrink-0 items-center justify-center rounded text-studio-muted hover:text-studio-text', !kids.length && 'invisible')}
          >
            <ChevronRight aria-hidden className={cn('size-3.5 transition-transform', expanded && 'rotate-90')} />
          </button>
          <button type="button" aria-current={current === f.id ? 'true' : undefined} onClick={() => onOpen(f.id)} className={row(current === f.id, over === f.id)} {...dropProps(f.id)}>
            {current === f.id ? <FolderOpen aria-hidden className="size-4 shrink-0" /> : <FolderIcon aria-hidden className="size-4 shrink-0" />}
            <span className="truncate">{f.name}</span>
            <span className="ml-auto font-mono text-[11px] text-studio-muted">{f.item_count}</span>
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={`Folder options for ${f.name}`}
              className="flex size-6 shrink-0 items-center justify-center rounded text-studio-muted opacity-0 hover:text-studio-text focus-visible:opacity-100 group-hover/folder:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100"
            >
              <MoreHorizontal aria-hidden className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onSelect={() => {
                  setOpen((s) => ({ ...s, [f.id]: true }))
                  setEditing({ mode: 'new', id: f.id })
                }}
              >
                <FolderPlus aria-hidden />
                New folder inside
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setEditing({ mode: 'rename', id: f.id })}>
                <Pencil aria-hidden />
                Rename
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setDeleting(f)} className="text-studio-danger">
                <Trash2 aria-hidden />
                Delete folder
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {(expanded || (editing?.mode === 'new' && editing.id === f.id)) && (
          <ul>
            {kids.map((k) => node(k, depth + 1))}
            {editing?.mode === 'new' && editing.id === f.id && newForm(f.id, depth + 1)}
          </ul>
        )}
      </li>
    )
  }

  const newForm = (parent: string | null, depth: number) => (
    <li key="new" style={{ paddingLeft: depth * 12 }}>
      <NameForm
        initial=""
        label="New folder name"
        onDone={(name) => {
          setEditing(null)
          if (name) onCreate(name, parent)
        }}
      />
    </li>
  )

  const parentName = deleting?.parent_id ? (folders.find((f) => f.id === deleting.parent_id)?.name ?? 'its parent') : rootLabel

  return (
    <nav aria-label="Folders" className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <h2 className="section-label">Folders</h2>
        <button
          type="button"
          onClick={() => setEditing({ mode: 'new', id: null })}
          className="inline-flex h-7 items-center gap-1 rounded-[6px] px-1.5 text-small text-studio-accent-hover hover:bg-studio-panel-hover"
        >
          <FolderPlus aria-hidden className="size-3.5" />
          New folder
        </button>
      </div>
      <ul className="flex flex-col gap-0.5">
        <li className="flex">
          <button type="button" aria-current={current == null ? 'true' : undefined} onClick={() => onOpen(null)} className={row(current == null, over === null)} {...dropProps(null)}>
            <Library aria-hidden className="size-4 shrink-0" />
            <span className="truncate">{rootLabel}</span>
          </button>
        </li>
        {childrenOf(folders, null).map((f) => node(f, 0))}
        {editing?.mode === 'new' && editing.id == null && newForm(null, 0)}
      </ul>
      {!folders.length && editing == null && <p className="px-1.5 text-small text-studio-muted">Make a folder, then drag pictures onto it or use Move.</p>}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete the folder “${deleting?.name ?? ''}”?`}
        description={`Its ${deleting?.item_count ?? 0} item${deleting?.item_count === 1 ? '' : 's'} and any folders inside move up to “${parentName}”. Nothing is deleted from your library.`}
        confirmLabel="Delete folder"
        tone="danger"
        onConfirm={() => {
          const f = deleting
          setDeleting(null)
          if (f) onDelete(f)
        }}
      />
    </nav>
  )
}
