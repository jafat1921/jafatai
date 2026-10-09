import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { BookImage, Download, SlidersHorizontal, X } from 'lucide-react'
import { Link } from 'react-router'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { ErrorState } from '@/components/studio/states'
import { catalogueKeys } from '@/hooks/useCatalogue'
import { api } from '@/lib/api'
import { exposureLine, sourceBadge, type Album } from '@/lib/catalogue'
import type { MediaItem } from '@/lib/types'
import { FlagPicker, LabelPicker, StarPicker } from './marks'

type Marks = { rating?: number; flag?: 'pick' | 'reject' | 'none'; label?: string }

interface Props {
  item: MediaItem | undefined
  selectedCount: number
  albums: Album[]
  onMarks: (m: Marks) => void
  onRemoveFromAlbum: (albumId: string, id: string) => void
  developHref: string | null
}

const fmtBytes = (b?: number | null) => (!b ? null : b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`)
const fmtWhen = (iso?: string | null) => (iso ? new Date(iso.endsWith('Z') ? iso : `${iso}Z`).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : null)

function Meta({ label, value }: { label: string; value: React.ReactNode }) {
  if (value == null || value === '') return null
  return (
    <>
      <dt className="text-studio-muted">{label}</dt>
      <dd className="min-w-0 break-words">{value}</dd>
    </>
  )
}

/** Keywords as chips: Enter or comma adds, × removes. Saved at once (it's metadata, not an edit). */
function KeywordEditor({ value, onSave }: { value: string[]; onSave: (v: string[]) => void }) {
  const [draft, setDraft] = useState('')
  const add = () => {
    const words = draft.split(',').map((w) => w.trim().toLowerCase()).filter(Boolean)
    if (words.length) onSave([...new Set([...value, ...words])])
    setDraft('')
  }
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-1">
        {value.map((k) => (
          <span key={k} className="flex items-center gap-0.5 rounded-full bg-studio-raised px-2 py-0.5 text-[12px]">
            {k}
            <button type="button" aria-label={`Remove keyword ${k}`} onClick={() => onSave(value.filter((x) => x !== k))} className="rounded-full p-0.5 text-studio-muted hover:text-studio-text">
              <X className="size-3" />
            </button>
          </span>
        ))}
      </div>
      <Input
        aria-label="Add keywords"
        placeholder="Add keywords, comma separated"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault()
            add()
          }
        }}
        onBlur={add}
        className="h-7"
      />
    </div>
  )
}

export function InfoPanel({ item, selectedCount, albums, onMarks, onRemoveFromAlbum, developHref }: Props) {
  const qc = useQueryClient()
  const [allMeta, setAllMeta] = useState(false)
  const [failure, setFailure] = useState<unknown>(null)
  const exif = useQuery({ queryKey: ['photos', 'exif', item?.id], queryFn: () => api.photos.exif(item!.id), enabled: !!item && allMeta })

  if (selectedCount > 1) {
    return (
      <div className="flex flex-col gap-3">
        <h2 className="font-display text-title font-semibold">{selectedCount} photos selected</h2>
        <p className="text-small text-studio-muted">Marks here apply to every selected photo.</p>
        <StarPicker value={0} onChange={(rating) => onMarks({ rating })} />
        <FlagPicker value="" onChange={(flag) => onMarks({ flag })} />
        <LabelPicker value="" onChange={(label) => onMarks({ label })} />
      </div>
    )
  }
  if (!item) return <p className="text-small text-studio-muted">Select a photo to see its details.</p>

  const save = (body: { title?: string; caption?: string; keywords?: string[] }) =>
    api.photos.update(item.id, body).then(() => qc.invalidateQueries({ queryKey: catalogueKeys.photos }), setFailure)
  const mine = albums.filter((a) => item.album_ids?.includes(a.id))
  const badge = sourceBadge(item.source_type)

  return (
    <div key={item.id} className="flex flex-col gap-4">
      <section aria-label="Marks" className="flex flex-col gap-2">
        <StarPicker value={item.rating ?? 0} onChange={(rating) => onMarks({ rating })} />
        <FlagPicker value={item.flag ?? ''} onChange={(flag) => onMarks({ flag })} />
        <LabelPicker value={item.label ?? ''} onChange={(label) => onMarks({ label })} />
      </section>

      {developHref && (
        <Button asChild variant="primary" size="sm">
          <Link to={developHref}><SlidersHorizontal aria-hidden /> Develop (D)</Link>
        </Button>
      )}

      {failure != null && <ErrorState compact title="Not saved" error={failure} />}
      <section aria-label="Description" className="flex flex-col gap-2">
        <label className="flex flex-col gap-1 text-small">
          <span className="section-label">Title</span>
          <Input defaultValue={item.title} onBlur={(e) => e.target.value.trim() !== item.title && save({ title: e.target.value })} className="h-7" />
        </label>
        <label className="flex flex-col gap-1 text-small">
          <span className="section-label">Caption</span>
          <Textarea rows={2} defaultValue={item.caption ?? ''} onBlur={(e) => e.target.value !== (item.caption ?? '') && save({ caption: e.target.value })} />
        </label>
        <div className="flex flex-col gap-1 text-small">
          <span className="section-label">Keywords</span>
          <KeywordEditor value={item.tags ?? []} onSave={(keywords) => save({ keywords })} />
        </div>
      </section>

      <section aria-label="Camera and file">
        <h3 className="section-label mb-1">Metadata</h3>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-small">
          <Meta label="Captured" value={fmtWhen(item.captured_at)} />
          <Meta label="Camera" value={item.camera} />
          <Meta label="Lens" value={item.lens} />
          <Meta label="Exposure" value={exposureLine(item) || null} />
          <Meta label="Size" value={item.width ? `${item.width} × ${item.height}` : null} />
          <Meta label="File" value={[item.original_name, badge, fmtBytes(item.bytes)].filter(Boolean).join(' · ') || null} />
          <Meta label="Added" value={fmtWhen(item.created_at)} />
        </dl>
        {item.source_type && (
          <Button asChild size="sm" variant="outline" className="mt-2">
            <a href={api.photos.sourceUrl(item.id)} download><Download aria-hidden /> Download original {badge}</a>
          </Button>
        )}
        <button type="button" aria-expanded={allMeta} onClick={() => setAllMeta((v) => !v)} className="mt-2 text-small text-studio-accent hover:underline">
          {allMeta ? 'Hide all metadata' : 'All metadata…'}
        </button>
        {allMeta && exif.data && (
          <dl className="mt-1 grid max-h-64 grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 overflow-y-auto rounded-[6px] bg-studio-raised p-2 font-mono text-[11px]">
            {Object.entries(exif.data.tags).map(([k, v]) => <Meta key={k} label={k} value={v} />)}
            {!Object.keys(exif.data.tags).length && <dd className="col-span-2 text-studio-muted">This file carries no EXIF.</dd>}
          </dl>
        )}
      </section>

      <section aria-label="Albums">
        <h3 className="section-label mb-1">In albums</h3>
        {mine.length === 0 && <p className="text-small text-studio-muted">Not in an album yet. Drag it onto one, or press B with a target album set.</p>}
        <div className="flex flex-wrap gap-1">
          {mine.map((a) => (
            <span key={a.id} className="flex items-center gap-1 rounded-full bg-studio-raised px-2 py-0.5 text-[12px]">
              <BookImage aria-hidden className="size-3" /> {a.name}
              {(a.kind === 'album' || a.kind === 'shoot') && (
                <button type="button" aria-label={`Remove from ${a.name}`} onClick={() => onRemoveFromAlbum(a.id, item.id)} className="rounded-full p-0.5 text-studio-muted hover:text-studio-text">
                  <X className="size-3" />
                </button>
              )}
            </span>
          ))}
        </div>
      </section>
    </div>
  )
}
