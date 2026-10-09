import { useId, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input, fieldClass } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { ErrorState } from '@/components/studio/states'
import { LABELS, type Album, type AlbumKind, type Client, type SmartRule, type SmartRules } from '@/lib/catalogue'
import { cn } from '@/lib/utils'

// ---------------------------------------------------------------- smart rules

type FieldSpec = { label: string; ops: { id: string; label: string }[]; input: 'number' | 'text' | 'date' | 'flag' | 'label' | 'origin' | 'bool' | 'album' | 'days' }

const RULE_FIELDS: Record<string, FieldSpec> = {
  rating: { label: 'Rating', input: 'number', ops: [{ id: '>=', label: 'is at least' }, { id: '<=', label: 'is at most' }, { id: '=', label: 'is' }, { id: '!=', label: 'is not' }] },
  flag: { label: 'Flag', input: 'flag', ops: [{ id: '=', label: 'is' }, { id: '!=', label: 'is not' }] },
  label: { label: 'Colour label', input: 'label', ops: [{ id: '=', label: 'is' }, { id: '!=', label: 'is not' }] },
  camera: { label: 'Camera', input: 'text', ops: [{ id: 'contains', label: 'contains' }, { id: '=', label: 'is' }] },
  lens: { label: 'Lens', input: 'text', ops: [{ id: 'contains', label: 'contains' }, { id: '=', label: 'is' }] },
  keyword: { label: 'Keyword', input: 'text', ops: [{ id: 'has', label: 'has' }, { id: 'lacks', label: "doesn't have" }] },
  text: { label: 'Title or caption', input: 'text', ops: [{ id: 'contains', label: 'contains' }] },
  captured: { label: 'Capture date', input: 'days', ops: [{ id: 'in_last_days', label: 'in the last (days)' }, { id: 'after', label: 'is on or after' }, { id: 'before', label: 'is before' }] },
  origin: { label: 'Source', input: 'origin', ops: [{ id: '=', label: 'is' }] },
  edited: { label: 'Edited', input: 'bool', ops: [{ id: '=', label: 'is' }] },
  album: { label: 'Album', input: 'album', ops: [{ id: 'in', label: 'is in' }, { id: 'not_in', label: 'is not in' }] },
  iso: { label: 'ISO', input: 'number', ops: [{ id: '>=', label: 'is at least' }, { id: '<=', label: 'is at most' }] },
  focal: { label: 'Focal length (mm)', input: 'number', ops: [{ id: '>=', label: 'is at least' }, { id: '<=', label: 'is at most' }] },
  aperture: { label: 'Aperture (f/)', input: 'number', ops: [{ id: '<=', label: 'is at most' }, { id: '>=', label: 'is at least' }] },
}

const defaultValue = (field: string): SmartRule['value'] =>
  ({ rating: 4, flag: 'pick', label: 'red', origin: 'upload', edited: true, captured: 30 } as Record<string, SmartRule['value']>)[field] ?? ''

export function RulesEditor({ value, onChange, albums }: { value: SmartRules; onChange: (r: SmartRules) => void; albums: Album[] }) {
  const set = (i: number, patch: Partial<SmartRule>) => onChange({ ...value, rules: value.rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) })
  return (
    <div className="flex flex-col gap-2">
      <label className="flex items-center gap-2 text-small">
        Match
        <select value={value.match} onChange={(e) => onChange({ ...value, match: e.target.value as 'all' | 'any' })} className={cn(fieldClass, 'h-8 w-28')}>
          <option value="all">all rules</option>
          <option value="any">any rule</option>
        </select>
      </label>
      {value.rules.map((r, i) => {
        const spec = RULE_FIELDS[r.field]
        const field = (
          <select aria-label={`Rule ${i + 1} field`} value={r.field} onChange={(e) => set(i, { field: e.target.value, op: RULE_FIELDS[e.target.value].ops[0].id, value: defaultValue(e.target.value) })} className={cn(fieldClass, 'h-8 w-40')}>
            {Object.entries(RULE_FIELDS).map(([k, f]) => <option key={k} value={k}>{f.label}</option>)}
          </select>
        )
        const op = (
          <select aria-label={`Rule ${i + 1} condition`} value={r.op} onChange={(e) => set(i, { op: e.target.value, value: r.field === 'captured' && e.target.value !== 'in_last_days' ? new Date().toISOString().slice(0, 10) : r.value })} className={cn(fieldClass, 'h-8 w-40')}>
            {spec.ops.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        )
        const common = { 'aria-label': `Rule ${i + 1} value`, className: cn(fieldClass, 'h-8 min-w-0 flex-1') }
        let input: React.ReactNode
        if (spec.input === 'flag') input = <select {...common} value={String(r.value)} onChange={(e) => set(i, { value: e.target.value })}><option value="pick">Pick</option><option value="reject">Rejected</option><option value="none">Unflagged</option></select>
        else if (spec.input === 'label') input = <select {...common} value={String(r.value)} onChange={(e) => set(i, { value: e.target.value })}>{LABELS.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}<option value="none">No label</option></select>
        else if (spec.input === 'origin') input = <select {...common} value={String(r.value)} onChange={(e) => set(i, { value: e.target.value })}><option value="upload">Imported photos</option><option value="generated">Made with AI</option></select>
        else if (spec.input === 'bool') input = <select {...common} value={String(r.value)} onChange={(e) => set(i, { value: e.target.value === 'true' })}><option value="true">Yes</option><option value="false">No</option></select>
        else if (spec.input === 'album') input = <select {...common} value={String(r.value)} onChange={(e) => set(i, { value: e.target.value })}><option value="">Choose…</option>{albums.filter((a) => a.kind !== 'folder').map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
        else if (spec.input === 'days' && r.op !== 'in_last_days') input = <input {...common} type="date" value={String(r.value)} onChange={(e) => set(i, { value: e.target.value })} />
        else if (spec.input === 'number' || spec.input === 'days') input = <input {...common} type="number" min={0} value={String(r.value)} onChange={(e) => set(i, { value: e.target.value === '' ? '' : Number(e.target.value) })} />
        else input = <input {...common} value={String(r.value ?? '')} onChange={(e) => set(i, { value: e.target.value })} />
        return (
          <div key={i} className="flex flex-wrap items-center gap-1.5">
            {field}
            {op}
            {input}
            <Button type="button" size="icon-sm" variant="ghost" aria-label={`Remove rule ${i + 1}`} disabled={value.rules.length === 1} onClick={() => onChange({ ...value, rules: value.rules.filter((_, j) => j !== i) })}>
              <Trash2 />
            </Button>
          </div>
        )
      })}
      <Button type="button" size="sm" variant="outline" className="self-start" disabled={value.rules.length >= 20} onClick={() => onChange({ ...value, rules: [...value.rules, { field: 'rating', op: '>=', value: 4 }] })}>
        <Plus aria-hidden /> Add rule
      </Button>
    </div>
  )
}

// ---------------------------------------------------------------- album / folder / shoot / smart

const TITLES: Record<AlbumKind, string> = { album: 'album', folder: 'album folder', smart: 'smart album', shoot: 'shoot' }

export interface AlbumDraft {
  id?: string
  kind: AlbumKind
  name: string
  parent_id: string | null
  client_id: string | null
  shoot_date: string | null
  venue: string
  notes: string
  rules: SmartRules | null
}

export function AlbumDialog({ draft, albums, clients, onClose, onSave }: {
  draft: AlbumDraft | null
  albums: Album[]
  clients: Client[]
  onClose: () => void
  onSave: (d: AlbumDraft) => Promise<unknown>
}) {
  return (
    <Dialog open={!!draft} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">{draft && <AlbumForm key={draft.id ?? draft.kind} draft={draft} albums={albums} clients={clients} onClose={onClose} onSave={onSave} />}</DialogContent>
    </Dialog>
  )
}

function AlbumForm({ draft, albums, clients, onClose, onSave }: { draft: AlbumDraft; albums: Album[]; clients: Client[]; onClose: () => void; onSave: (d: AlbumDraft) => Promise<unknown> }) {
  const id = useId()
  const [d, setD] = useState<AlbumDraft>(draft)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const set = (p: Partial<AlbumDraft>) => setD((x) => ({ ...x, ...p }))
  const folders = albums.filter((a) => a.kind === 'folder' && a.id !== d.id)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await onSave(d)
      onClose()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <DialogHeader>
        <DialogTitle>{d.id ? `Edit ${TITLES[d.kind]}` : `New ${TITLES[d.kind]}`}</DialogTitle>
        <DialogDescription>
          {d.kind === 'smart' ? 'Fills itself with every photo that matches the rules, and stays up to date.'
            : d.kind === 'folder' ? 'Holds albums and other folders, like a shelf.'
              : d.kind === 'shoot' ? 'An album for one session: who it was for, when and where.'
                : 'A photo can be in any number of albums; nothing is copied.'}
        </DialogDescription>
      </DialogHeader>
      {error != null && <ErrorState compact title="Not saved" error={error} />}
      <label className="flex flex-col gap-1 text-small" htmlFor={`${id}-name`}>
        Name
        <Input id={`${id}-name`} required autoFocus maxLength={160} value={d.name} onChange={(e) => set({ name: e.target.value })} />
      </label>
      {d.kind === 'shoot' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-small">
            Client
            <select value={d.client_id ?? ''} onChange={(e) => set({ client_id: e.target.value || null })} className={cn(fieldClass, 'h-8')}>
              <option value="">No client</option>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-small">
            Date
            <input type="date" value={d.shoot_date ?? ''} onChange={(e) => set({ shoot_date: e.target.value || null })} className={cn(fieldClass, 'h-8')} />
          </label>
          <label className="flex flex-col gap-1 text-small sm:col-span-2">
            Venue
            <Input maxLength={200} value={d.venue} onChange={(e) => set({ venue: e.target.value })} />
          </label>
        </div>
      )}
      {!(d.kind === 'shoot' && d.client_id) && (
        <label className="flex flex-col gap-1 text-small">
          Inside
          <select value={d.parent_id ?? ''} onChange={(e) => set({ parent_id: e.target.value || null })} className={cn(fieldClass, 'h-8')}>
            <option value="">Top level</option>
            {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </label>
      )}
      {d.kind === 'smart' && d.rules && <RulesEditor value={d.rules} onChange={(rules) => set({ rules })} albums={albums.filter((a) => a.id !== d.id)} />}
      {(d.kind === 'shoot' || d.kind === 'album') && (
        <label className="flex flex-col gap-1 text-small">
          Notes
          <Textarea rows={2} maxLength={4000} value={d.notes} onChange={(e) => set({ notes: e.target.value })} />
        </label>
      )}
      <DialogFooter>
        <Button type="button" onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" loading={busy}>{d.id ? 'Save' : 'Create'}</Button>
      </DialogFooter>
    </form>
  )
}

// ---------------------------------------------------------------- client

export interface ClientDraft {
  id?: string
  name: string
  email: string
  phone: string
  notes: string
}

export function ClientDialog({ draft, onClose, onSave }: { draft: ClientDraft | null; onClose: () => void; onSave: (d: ClientDraft) => Promise<unknown> }) {
  return (
    <Dialog open={!!draft} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>{draft && <ClientForm key={draft.id ?? 'new'} draft={draft} onClose={onClose} onSave={onSave} />}</DialogContent>
    </Dialog>
  )
}

function ClientForm({ draft, onClose, onSave }: { draft: ClientDraft; onClose: () => void; onSave: (d: ClientDraft) => Promise<unknown> }) {
  const [d, setD] = useState(draft)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const set = (p: Partial<ClientDraft>) => setD((x) => ({ ...x, ...p }))
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={async (e) => {
        e.preventDefault()
        setBusy(true)
        try {
          await onSave(d)
          onClose()
        } catch (err) {
          setError(err)
        } finally {
          setBusy(false)
        }
      }}
    >
      <DialogHeader>
        <DialogTitle>{d.id ? 'Edit client' : 'New client'}</DialogTitle>
        <DialogDescription>Shoots for this client appear under their name in Sources.</DialogDescription>
      </DialogHeader>
      {error != null && <ErrorState compact title="Not saved" error={error} />}
      <label className="flex flex-col gap-1 text-small">Name<Input required autoFocus maxLength={160} value={d.name} onChange={(e) => set({ name: e.target.value })} /></label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-small">Email<Input type="email" maxLength={200} value={d.email} onChange={(e) => set({ email: e.target.value })} /></label>
        <label className="flex flex-col gap-1 text-small">Phone<Input type="tel" maxLength={60} value={d.phone} onChange={(e) => set({ phone: e.target.value })} /></label>
      </div>
      <label className="flex flex-col gap-1 text-small">Notes<Textarea rows={3} maxLength={4000} value={d.notes} onChange={(e) => set({ notes: e.target.value })} /></label>
      <DialogFooter>
        <Button type="button" onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" loading={busy}>{d.id ? 'Save' : 'Add client'}</Button>
      </DialogFooter>
    </form>
  )
}
