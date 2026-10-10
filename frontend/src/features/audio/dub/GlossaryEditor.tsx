import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { GlossaryRow } from '@/lib/dub'

interface Props {
  glossary: GlossaryRow[]
  targets: string[]
  name: (code: string) => string
  saving: boolean
  onSave: (rows: GlossaryRow[]) => void
}

const blank = (): GlossaryRow => ({ source: '', target: {}, note: '' })

const tidy = (r: GlossaryRow): GlossaryRow => ({
  source: r.source.trim(),
  target: Object.fromEntries(Object.entries(r.target).filter(([, v]) => v.trim()).map(([k, v]) => [k, v.trim()])),
  ...(r.note?.trim() ? { note: r.note.trim() } : {}),
})

/** Names and terms pinned in every translation prompt; an empty translation means "keep it as is". */
export function GlossaryEditor({ glossary, targets, name, saving, onSave }: Props) {
  const [rows, setRows] = useState<GlossaryRow[]>(() => (glossary.length ? glossary : [blank()]))
  const set = (i: number, row: GlossaryRow) => setRows((r) => r.map((x, k) => (k === i ? row : x)))
  const clean = rows.filter((r) => r.source.trim()).map(tidy)
  const dirty = JSON.stringify(clean) !== JSON.stringify(glossary.map(tidy))

  return (
    <div className="flex flex-col gap-2">
      <p className="text-small text-studio-muted">Character names, places and terms the translation must keep. Leave a language empty to keep the word as it is.</p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[480px] text-small">
          <thead>
            <tr className="text-left text-[11px] text-studio-muted">
              <th className="px-1 py-1 font-medium">Term</th>
              {targets.map((t) => (
                <th key={t} className="px-1 py-1 font-medium">
                  {name(t)}
                </th>
              ))}
              <th className="px-1 py-1 font-medium">Note</th>
              <th className="w-8" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="p-1">
                  <Input aria-label={`Term ${i + 1}`} value={r.source} maxLength={200} onChange={(e) => set(i, { ...r, source: e.target.value })} className="h-7" />
                </td>
                {targets.map((t) => (
                  <td key={t} className="p-1">
                    <Input
                      aria-label={`Term ${i + 1} in ${name(t)}`}
                      dir="auto"
                      lang={t}
                      value={r.target[t] ?? ''}
                      maxLength={200}
                      onChange={(e) => set(i, { ...r, target: { ...r.target, [t]: e.target.value } })}
                      className="h-7"
                    />
                  </td>
                ))}
                <td className="p-1">
                  <Input aria-label={`Note for term ${i + 1}`} value={r.note ?? ''} maxLength={300} onChange={(e) => set(i, { ...r, note: e.target.value })} className="h-7" />
                </td>
                <td className="p-1">
                  <Button type="button" size="icon-sm" variant="ghost" aria-label={`Remove term ${i + 1}`} onClick={() => setRows((x) => x.filter((_, k) => k !== i))}>
                    <Trash2 aria-hidden />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={() => setRows((r) => [...r, blank()])}>
          <Plus aria-hidden />
          Add a term
        </Button>
        <Button
          type="button"
          size="sm"
          variant="primary"
          className="ml-auto"
          disabled={!dirty}
          loading={saving}
          onClick={() => onSave(clean)}
        >
          Save glossary
        </Button>
      </div>
    </div>
  )
}
