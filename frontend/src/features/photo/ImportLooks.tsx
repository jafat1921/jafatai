import { useId, useRef, useState } from 'react'
import { AlertTriangle, Check, FileUp, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ErrorState } from '@/components/studio/states'
import type { ImportReport, ImportResult } from '@/lib/photo/types'
import { cn, plural } from '@/lib/utils'

const EXTS = ['.xmp', '.lrtemplate', '.cube']
const MAX_BYTES = 16 * 1024 * 1024

interface Props {
  onImport: (files: File[]) => Promise<ImportResult>
  pending: boolean
}

/** Drop or pick Lightroom presets and 3D LUTs; each file gets a line saying what came across. */
export function ImportLooks({ onImport, pending }: Props) {
  const id = useId()
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const [reports, setReports] = useState<ImportReport[]>([])
  const [error, setError] = useState<unknown>(null)

  const send = async (list: FileList | File[]) => {
    const files = Array.from(list)
    // say no to the obvious ones here; the server reports the rest
    const local: ImportReport[] = []
    const ok = files.filter((f) => {
      const ext = f.name.slice(f.name.lastIndexOf('.')).toLowerCase()
      if (!EXTS.includes(ext)) local.push({ file: f.name, ok: false, error: 'Only .xmp, .lrtemplate and .cube files can be imported' })
      else if (f.size > MAX_BYTES) local.push({ file: f.name, ok: false, error: 'Over 16 MB' })
      else return true
      return false
    })
    setError(null)
    if (!ok.length) return setReports(local)
    try {
      const res = await onImport(ok.slice(0, 20))
      setReports([...res.reports, ...local])
    } catch (e) {
      setReports(local)
      setError(e)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div
        onDragOver={(e) => {
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setOver(false)
          if (e.dataTransfer.files.length) void send(e.dataTransfer.files)
        }}
        className={cn(
          'flex items-center gap-2.5 rounded-[8px] border border-dashed border-studio-border-strong bg-studio-raised/70 p-2.5 transition-colors duration-150',
          over && 'border-studio-accent bg-studio-accent-soft',
        )}
      >
        <FileUp aria-hidden className="size-4 shrink-0 text-studio-accent" />
        <p id={`${id}-hint`} className="min-w-0 flex-1 text-small text-studio-muted">
          Drop Lightroom presets (.xmp, .lrtemplate) or LUTs (.cube)
        </p>
        <Button size="sm" variant="secondary" loading={pending} onClick={() => input.current?.click()} aria-describedby={`${id}-hint`}>
          Import
        </Button>
        <input
          ref={input}
          type="file"
          hidden
          multiple
          accept={EXTS.join(',')}
          aria-label="Import looks"
          data-testid="look-import-input"
          onChange={(e) => {
            if (e.target.files?.length) void send(e.target.files)
            e.target.value = ''
          }}
        />
      </div>
      {error != null && <ErrorState compact title="Import failed" error={error} />}
      {reports.length > 0 && (
        <section aria-label="Import report" className="flex flex-col gap-1.5 rounded-[6px] border border-studio-border bg-studio-raised p-2">
          <div className="flex items-center justify-between">
            <span className="section-label">Import report</span>
            <Button size="icon-sm" variant="ghost" aria-label="Dismiss the import report" onClick={() => setReports([])}>
              <X aria-hidden />
            </Button>
          </div>
          <ul className="flex flex-col gap-1.5">
            {reports.map((r, i) => (
              <li key={`${r.file}-${i}`} className="flex gap-1.5 text-small">
                {r.ok ? <Check aria-hidden className="mt-0.5 size-3.5 shrink-0 text-studio-success" /> : <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0 text-studio-danger" />}
                <div className="min-w-0">
                  <p className="font-medium">
                    {r.ok ? `Imported “${r.name ?? r.file}”` : `${r.file}: not imported`}
                    {r.ok && r.kind === 'cube' && r.cube_size ? ` · ${r.cube_size}³ LUT` : ''}
                  </p>
                  {!r.ok && <p className="text-studio-muted">{r.error}</p>}
                  {r.ok && r.mapped && r.kind !== 'cube' && <p className="text-studio-muted">{plural(r.mapped.length, 'setting')} carried over.</p>}
                  {r.ok && !!r.unmapped?.length && (
                    <p className="text-studio-warning">
                      Not carried ({r.unmapped.length}): <span className="font-mono text-[12px]">{r.unmapped.join(', ')}</span>
                    </p>
                  )}
                  {r.notes?.map((n) => (
                    <p key={n} className="text-studio-muted">
                      {n}
                    </p>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
