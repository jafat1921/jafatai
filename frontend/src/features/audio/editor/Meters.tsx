import { AlertTriangle } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { FLAG_TEXT, minus, previewFlags } from '@/lib/audio-edit'
import type { AudioAnalysis, AudioFlag, AudioPreview } from '@/lib/types'
import { cn } from '@/lib/utils'

const db = (n: number | null | undefined, unit: string) => (n == null ? '–' : `${minus(n, 1)} ${unit}`)

export function FlagBadges({ flags, className }: { flags: AudioFlag[]; className?: string }) {
  if (!flags.length) return null
  return (
    <ul aria-label="Quality warnings" className={cn('flex flex-wrap gap-1', className)}>
      {flags.map((f) => (
        <li key={f}>
          <Badge tone={f === 'long_silence' ? 'neutral' : 'warning'}>
            <AlertTriangle aria-hidden />
            {FLAG_TEXT[f]}
          </Badge>
        </li>
      ))}
    </ul>
  )
}

function Column({ label, lufs, tp, lra, flags, pending, active }: { label: string; lufs?: number | null; tp?: number | null; lra?: number | null; flags: AudioFlag[]; pending?: boolean; active: boolean }) {
  return (
    <section aria-label={`${label} levels`} className={cn('flex min-w-0 flex-1 flex-col gap-1 rounded-[4px] border px-2 py-1.5', active ? 'border-studio-accent/50 bg-studio-accent-soft/40' : 'border-studio-border')}>
      <h3 className="section-label flex items-center gap-1">
        {label}
        {pending && <span className="normal-case tracking-normal text-studio-faint">· measuring…</span>}
      </h3>
      <dl className="grid grid-cols-[auto_1fr] gap-x-2 text-small">
        <dt className="text-studio-faint">Integrated</dt>
        <dd className="text-right font-mono tabular-nums">{db(lufs, 'LUFS')}</dd>
        <dt className="text-studio-faint">True peak</dt>
        <dd className="text-right font-mono tabular-nums">{db(tp, 'dBTP')}</dd>
        {lra !== undefined && (
          <>
            <dt className="text-studio-faint">Range (LRA)</dt>
            <dd className="text-right font-mono tabular-nums">{lra == null ? '–' : `${lra.toFixed(1)} LU`}</dd>
          </>
        )}
      </dl>
      <FlagBadges flags={flags} />
    </section>
  )
}

/** Loudness of the original (from /analysis) beside the edit (from the preview's headers). */
export function Meters({ analysis, preview, pendingA, pendingB, listen, hasEdit }: {
  analysis: AudioAnalysis | undefined
  preview: AudioPreview | null
  pendingA: boolean
  pendingB: boolean
  listen: 'A' | 'B'
  hasEdit: boolean
}) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row">
      <Column label="A · Original" lufs={analysis?.lufs_i} tp={analysis?.true_peak_db} lra={analysis?.lra ?? null} flags={analysis?.flags ?? []} pending={pendingA} active={listen === 'A'} />
      {hasEdit ? (
        <Column label="B · Edited" lufs={preview?.lufsI} tp={preview?.truePeakDb} flags={previewFlags(preview)} pending={pendingB} active={listen === 'B'} />
      ) : (
        <p className="flex flex-1 items-center rounded-[4px] border border-dashed border-studio-border px-2 py-1.5 text-small text-studio-faint">
          Make a change to hear and measure B, the edited version.
        </p>
      )}
    </div>
  )
}
