import { useState, type DragEvent, type ReactNode } from 'react'
import {
  BookImage, Calendar, Camera, ChevronDown, ChevronRight, Clock, Flag, FolderClosed, Heart, Images, Inbox, MoreHorizontal, Plus, Sparkles, Target, UserRound, X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { albumTree, sourceKey, type Album, type Client, type Source } from '@/lib/catalogue'
import { DRAG_MIME } from '@/lib/selection'
import { cn } from '@/lib/utils'

export type NewKind = 'album' | 'folder' | 'smart' | 'shoot' | 'client'

interface Props {
  source: Source
  onSource: (s: Source) => void
  albums: Album[]
  clients: Client[]
  totals: { all?: number }
  target: string | null
  onTarget: (id: string | null) => void
  onNew: (kind: NewKind, parentId?: string | null, clientId?: string | null) => void
  onEdit: (album: Album) => void
  onEditClient: (client: Client) => void
  onDelete: (album: Album) => void
  onDeleteClient: (client: Client) => void
  onDropIds: (albumId: string, ids: string[]) => void
}

const ICON: Record<Album['kind'], typeof BookImage> = { folder: FolderClosed, album: BookImage, smart: Sparkles, shoot: Camera }

function Row({ active, onClick, icon, label, count, depth = 0, extra, onDrop, target }: {
  active: boolean
  onClick: () => void
  icon: ReactNode
  label: string
  count?: number
  depth?: number
  extra?: ReactNode
  onDrop?: (ids: string[]) => void
  target?: boolean
}) {
  const [over, setOver] = useState(false)
  const dropProps = onDrop
    ? {
        onDragOver: (e: DragEvent) => {
          if (!e.dataTransfer.types.includes(DRAG_MIME)) return
          e.preventDefault()
          setOver(true)
        },
        onDragLeave: () => setOver(false),
        onDrop: (e: DragEvent) => {
          setOver(false)
          const raw = e.dataTransfer.getData(DRAG_MIME)
          if (!raw) return
          e.preventDefault()
          try {
            onDrop(JSON.parse(raw) as string[])
          } catch {
            /* not ours */
          }
        },
      }
    : {}
  return (
    <div className={cn('group flex items-center rounded-[6px]', active ? 'bg-studio-accent-soft' : 'hover:bg-studio-panel-hover', over && 'ring-2 ring-studio-accent')} {...dropProps}>
      <button
        type="button"
        onClick={onClick}
        aria-current={active ? 'true' : undefined}
        className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pr-1 text-left text-small focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-studio-accent"
        style={{ paddingLeft: 8 + depth * 14 }}
      >
        <span className="shrink-0 text-studio-muted [&_svg]:size-4">{icon}</span>
        <span className={cn('truncate', active && 'font-medium')}>{label}</span>
        {target && <Target aria-label="Target album (B)" className="size-3.5 shrink-0 text-studio-accent" />}
        {count != null && <span className="ml-auto pl-1 text-[11px] tabular-nums text-studio-muted">{count}</span>}
      </button>
      {extra}
    </div>
  )
}

function Section({ title, children, action, open, onToggle }: { title: string; children: ReactNode; action?: ReactNode; open: boolean; onToggle: () => void }) {
  return (
    <section className="flex flex-col">
      <div className="flex items-center justify-between pr-1">
        <button type="button" onClick={onToggle} aria-expanded={open} className="section-label flex items-center gap-1 py-1.5 hover:text-studio-text">
          {open ? <ChevronDown aria-hidden className="size-3.5" /> : <ChevronRight aria-hidden className="size-3.5" />}
          {title}
        </button>
        {action}
      </div>
      {open && <div className="flex flex-col">{children}</div>}
    </section>
  )
}

export function SourcesPanel(p: Props) {
  const [open, setOpen] = useState({ catalogue: true, clients: true, albums: true })
  const [shut, setShut] = useState<Set<string>>(new Set())
  const is = (s: Source) => sourceKey(s) === sourceKey(p.source)
  const toggle = (k: keyof typeof open) => () => setOpen((o) => ({ ...o, [k]: !o[k] }))
  const shoots = p.albums.filter((a) => a.kind === 'shoot' && a.client_id)
  const tree = albumTree(p.albums.filter((a) => !(a.kind === 'shoot' && a.client_id)))
  // collapsed folders hide everything under them
  const hidden = new Set<string>()
  for (const { album } of tree) if (album.parent_id && (shut.has(album.parent_id) || hidden.has(album.parent_id))) hidden.add(album.id)

  const menu = (a: Album) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label={`${a.name} actions`} className="mr-0.5 rounded p-1 text-studio-muted opacity-0 hover:text-studio-text focus-visible:opacity-100 group-hover:opacity-100">
          <MoreHorizontal className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {(a.kind === 'album' || a.kind === 'shoot') && (
          <DropdownMenuItem onSelect={() => p.onTarget(p.target === a.id ? null : a.id)}>
            <Target /> {p.target === a.id ? 'Stop using as target' : 'Set as target album (B)'}
          </DropdownMenuItem>
        )}
        {a.kind === 'folder' && (
          <>
            <DropdownMenuItem onSelect={() => p.onNew('album', a.id)}><BookImage /> New album inside</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => p.onNew('smart', a.id)}><Sparkles /> New smart album inside</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => p.onNew('folder', a.id)}><FolderClosed /> New folder inside</DropdownMenuItem>
          </>
        )}
        <DropdownMenuItem onSelect={() => p.onEdit(a)}>{a.kind === 'smart' ? 'Edit rules…' : 'Edit…'}</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => p.onDelete(a)} className="text-studio-danger">Delete {a.kind === 'folder' ? 'folder' : 'album'}…</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )

  return (
    <nav aria-label="Photo sources" className="flex flex-col gap-2 text-studio-text">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="outline" className="w-full justify-start"><Plus aria-hidden /> New…</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onSelect={() => p.onNew('album')}><BookImage /> Album</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => p.onNew('smart')}><Sparkles /> Smart album</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => p.onNew('folder')}><FolderClosed /> Album folder</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => p.onNew('client')}><UserRound /> Client</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => p.onNew('shoot')}><Camera /> Shoot</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Section title="Catalogue" open={open.catalogue} onToggle={toggle('catalogue')}>
        <Row active={is({ kind: 'all' })} onClick={() => p.onSource({ kind: 'all' })} icon={<Images />} label="All photos" count={p.totals.all} />
        <Row active={is({ kind: 'recent' })} onClick={() => p.onSource({ kind: 'recent' })} icon={<Clock />} label="Recently added" />
        <Row active={is({ kind: 'picks' })} onClick={() => p.onSource({ kind: 'picks' })} icon={<Flag />} label="Picks" />
        <Row active={is({ kind: 'unsorted' })} onClick={() => p.onSource({ kind: 'unsorted' })} icon={<Inbox />} label="Not yet culled" />
        <Row active={is({ kind: 'rejected' })} onClick={() => p.onSource({ kind: 'rejected' })} icon={<X />} label="Rejected" />
        <Row active={is({ kind: 'favourites' })} onClick={() => p.onSource({ kind: 'favourites' })} icon={<Heart />} label="Favourites" />
      </Section>

      <Section
        title="Clients"
        open={open.clients}
        onToggle={toggle('clients')}
        action={<button type="button" aria-label="New client" onClick={() => p.onNew('client')} className="rounded p-1 text-studio-muted hover:text-studio-text"><Plus className="size-3.5" /></button>}
      >
        {p.clients.length === 0 && <p className="px-2 pb-1 text-[12px] text-studio-muted">Add a client to group their shoots.</p>}
        {p.clients.map((c) => (
          <div key={c.id}>
            <Row
              active={is({ kind: 'client', id: c.id })}
              onClick={() => p.onSource({ kind: 'client', id: c.id })}
              icon={<UserRound />}
              label={c.name}
              count={c.photos}
              extra={
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button type="button" aria-label={`${c.name} actions`} className="mr-0.5 rounded p-1 text-studio-muted opacity-0 hover:text-studio-text focus-visible:opacity-100 group-hover:opacity-100">
                      <MoreHorizontal className="size-4" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => p.onNew('shoot', null, c.id)}><Camera /> New shoot</DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => p.onEditClient(c)}>Edit client…</DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={() => p.onDeleteClient(c)} className="text-studio-danger">Delete client…</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              }
            />
            {shoots.filter((s) => s.client_id === c.id).map((s) => (
              <Row
                key={s.id}
                depth={1}
                active={is({ kind: 'album', id: s.id })}
                onClick={() => p.onSource({ kind: 'album', id: s.id })}
                icon={<Calendar />}
                label={s.shoot_date ? `${s.name} · ${s.shoot_date}` : s.name}
                count={s.count}
                target={p.target === s.id}
                onDrop={(ids) => p.onDropIds(s.id, ids)}
                extra={menu(s)}
              />
            ))}
          </div>
        ))}
      </Section>

      <Section
        title="Albums"
        open={open.albums}
        onToggle={toggle('albums')}
        action={<button type="button" aria-label="New album" onClick={() => p.onNew('album')} className="rounded p-1 text-studio-muted hover:text-studio-text"><Plus className="size-3.5" /></button>}
      >
        {tree.length === 0 && <p className="px-2 pb-1 text-[12px] text-studio-muted">Albums hold any photos; a photo can be in many.</p>}
        {tree.filter(({ album }) => !hidden.has(album.id)).map(({ album: a, depth }) => {
          const Icon = ICON[a.kind]
          const folder = a.kind === 'folder'
          return (
            <Row
              key={a.id}
              depth={depth}
              active={is({ kind: 'album', id: a.id })}
              onClick={() => {
                if (folder && is({ kind: 'album', id: a.id })) setShut((s) => { const n = new Set(s); if (n.has(a.id)) n.delete(a.id); else n.add(a.id); return n })
                p.onSource({ kind: 'album', id: a.id })
              }}
              icon={<Icon />}
              label={a.name}
              count={a.count}
              target={p.target === a.id}
              onDrop={a.kind === 'album' || a.kind === 'shoot' ? (ids) => p.onDropIds(a.id, ids) : undefined}
              extra={menu(a)}
            />
          )
        })}
      </Section>
    </nav>
  )
}
