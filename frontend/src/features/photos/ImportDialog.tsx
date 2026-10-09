import { useId, useRef, useState, type DragEvent } from 'react'
import { AlertTriangle, Check, Copy, ImageUp, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { fieldClass } from '@/components/ui/input'
import type { ImportRow } from '@/hooks/useCatalogue'
import type { Album } from '@/lib/catalogue'
import { PHOTO_ACCEPT, checkPhoto } from '@/lib/upload'
import { cn } from '@/lib/utils'

interface Props {
  open: boolean
  onOpenChange: (o: boolean) => void
  albums: Album[]
  defaultAlbum: string | null
  rows: ImportRow[]
  onImport: (files: File[], fields: { album_id?: string; on_duplicate: 'skip' | 'keep' }) => void
  onClearFinished: () => void
  onCancel: () => void
}

/** Import: many files, three at a time, into an album or shoot; duplicates skipped by content, not by name. */
export function ImportDialog({ open, onOpenChange, albums, defaultAlbum, rows, onImport, onClearFinished, onCancel }: Props) {
  const id = useId()
  const input = useRef<HTMLInputElement>(null)
  const [album, setAlbum] = useState<string>(defaultAlbum ?? '')
  const [dup, setDup] = useState<'skip' | 'keep'>('skip')
  const [problems, setProblems] = useState<string[]>([])
  const [over, setOver] = useState(false)
  const targets = albums.filter((a) => a.kind === 'album' || a.kind === 'shoot')

  const take = (list: FileList | File[] | null) => {
    const files = Array.from(list ?? [])
    const bad = files.map(checkPhoto).filter((x): x is string => !!x)
    setProblems(bad)
    const ok = files.filter((f) => !checkPhoto(f))
    if (ok.length) onImport(ok, { album_id: album || undefined, on_duplicate: dup })
  }

  const busy = rows.some((r) => r.state === 'waiting' || r.state === 'uploading')
  const done = rows.filter((r) => r.state === 'done').length
  const dups = rows.filter((r) => r.state === 'duplicate').length
  const failed = rows.filter((r) => r.state === 'failed').length

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import photos</DialogTitle>
          <DialogDescription>JPEG, PNG, WebP, HEIC, TIFF or camera RAW (NEF, CR3, ARW, RAF, DNG…). RAW and HEIC originals are kept; you edit a full-size copy.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-small" htmlFor={`${id}-album`}>
            Add to
            <select id={`${id}-album`} value={album} onChange={(e) => setAlbum(e.target.value)} className={cn(fieldClass, 'h-8')}>
              <option value="">Catalogue only</option>
              {targets.map((a) => <option key={a.id} value={a.id}>{a.kind === 'shoot' ? `Shoot · ${a.name}` : a.name}</option>)}
            </select>
          </label>
          <fieldset className="flex flex-col gap-1 text-small">
            <legend className="mb-1">Already in the catalogue</legend>
            <div className="flex gap-3">
              <label className="flex items-center gap-1.5"><input type="radio" name={`${id}-dup`} checked={dup === 'skip'} onChange={() => setDup('skip')} /> Skip</label>
              <label className="flex items-center gap-1.5"><input type="radio" name={`${id}-dup`} checked={dup === 'keep'} onChange={() => setDup('keep')} /> Import again</label>
            </div>
          </fieldset>
        </div>
        <div
          onDragOver={(e) => {
            e.preventDefault()
            setOver(true)
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e: DragEvent) => {
            e.preventDefault()
            setOver(false)
            take(e.dataTransfer.files)
          }}
          className={cn('mt-3 flex flex-col items-center gap-2 rounded-[8px] border-2 border-dashed p-6 text-center', over ? 'border-studio-accent bg-studio-accent-soft' : 'border-studio-border-strong')}
        >
          <ImageUp aria-hidden className="size-8 text-studio-muted" />
          <p className="text-small">Drop a folder's worth of photos here</p>
          <Button type="button" variant="primary" onClick={() => input.current?.click()}>Choose photos…</Button>
          <input ref={input} type="file" multiple accept={PHOTO_ACCEPT} className="sr-only" onChange={(e) => { take(e.target.files); e.target.value = '' }} />
        </div>
        {problems.length > 0 && (
          <ul className="mt-2 flex flex-col gap-0.5 text-small text-studio-danger" role="alert">
            {problems.slice(0, 5).map((p) => <li key={p}>{p}</li>)}
            {problems.length > 5 && <li>…and {problems.length - 5} more</li>}
          </ul>
        )}
        {rows.length > 0 && (
          <div className="mt-3">
            <p className="text-small" role="status" aria-live="polite">
              {done} imported{dups ? ` · ${dups} already there` : ''}{failed ? ` · ${failed} failed` : ''}{busy ? ` · ${rows.filter((r) => r.state === 'waiting').length} waiting` : ''}
            </p>
            <ul className="mt-1 max-h-56 overflow-y-auto rounded-[6px] border border-studio-border">
              {rows.map((r) => (
                <li key={r.key} className="flex items-center gap-2 border-b border-studio-border px-2 py-1 text-small last:border-0">
                  {r.state === 'done' && <Check aria-label="Imported" className="size-4 text-studio-success" />}
                  {r.state === 'duplicate' && <Copy aria-label="Already in the catalogue" className="size-4 text-studio-muted" />}
                  {r.state === 'failed' && <AlertTriangle aria-label="Failed" className="size-4 text-studio-danger" />}
                  {(r.state === 'uploading' || r.state === 'waiting') && <Loader2 aria-label="Importing" className={cn('size-4', r.state === 'uploading' && 'animate-spin')} />}
                  <span className="min-w-0 flex-1 truncate">{r.name}</span>
                  {r.state === 'uploading' && <span className="tabular-nums text-studio-muted">{Math.round(r.progress * 100)}%</span>}
                  {r.state === 'failed' && <span className="max-w-[50%] truncate text-studio-danger" title={r.error}>{r.error}</span>}
                  {r.state === 'duplicate' && <span className="text-studio-muted">already there</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
        <DialogFooter className="mt-3">
          {busy ? <Button onClick={onCancel}>Cancel the rest</Button> : rows.length > 0 && <Button onClick={onClearFinished}>Clear list</Button>}
          <Button variant="primary" onClick={() => onOpenChange(false)}>{busy ? 'Keep importing in the background' : 'Done'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
