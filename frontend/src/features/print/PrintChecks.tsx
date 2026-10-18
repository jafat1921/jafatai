import { CircleAlert, CircleCheck } from 'lucide-react'
import { SwitchRow } from '@/components/studio/switch-row'
import { ROLE_LABEL, type PrintReport } from '@/lib/print'

const cm = (mm: number | null | undefined) => (mm == null ? '–' : `${(mm / 10).toLocaleString('en-GB', { maximumFractionDigits: 2 })} cm`)

function Row({ ok, title, children }: { ok: boolean; title: string; children: React.ReactNode }) {
  const Icon = ok ? CircleCheck : CircleAlert
  return (
    <li className="flex min-w-0 gap-2">
      <Icon aria-hidden className={ok ? 'mt-0.5 size-4 shrink-0 text-studio-success' : 'mt-0.5 size-4 shrink-0 text-studio-warning'} />
      <div className="min-w-0">
        <p className="text-body font-medium">
          {title}
          <span className="sr-only">{ok ? ': passes' : ': check this'}</span>
        </p>
        <div className="text-small text-studio-muted">{children}</div>
      </div>
    </li>
  )
}

/** What a print shop would ask: will it read from the street, does every line pass contrast, where the trim and
 * safe area are, and which colours will print duller than on screen. */
export function PrintChecks({
  report,
  overlay,
  onOverlay,
  printSafe,
  onPrintSafe,
  idBase,
}: {
  report: PrintReport
  overlay: boolean
  onOverlay: (v: boolean) => void
  printSafe: boolean
  onPrintSafe: (v: boolean) => void
  idBase: string
}) {
  const mt = report.min_text
  const failing = Object.entries(report.contrast ?? {}).filter(([, r]) => r < 4.5)
  const gamut = report.gamut ?? []
  const dropped = (report.dropped ?? []).map((r) => ROLE_LABEL[r] ?? r)
  return (
    <section aria-labelledby={`${idBase}-checks`} className="flex min-w-0 flex-col gap-2 rounded-[8px] border border-studio-border bg-studio-raised p-3">
      <h3 id={`${idBase}-checks`} className="font-display text-body font-semibold">
        Print checks
      </h3>
      <ul className="flex flex-col gap-2.5">
        {mt && (
          <Row ok={mt.pass} title={`Smallest text ${cm(mt.cap_mm)}`}>
            Capitals of the {(ROLE_LABEL[mt.role ?? ''] ?? mt.role ?? 'smallest line').toLowerCase()}; read from the {mt.distance} they need at least {cm(mt.need_mm)}.
          </Row>
        )}
        <Row ok={failing.length === 0} title={failing.length === 0 ? 'Contrast passes WCAG AA' : 'Contrast too low'}>
          {failing.length === 0
            ? 'Every line is at least 4.5:1 against what it sits on.'
            : failing.map(([role, r]) => `${ROLE_LABEL[role] ?? role} ${r.toFixed(1)}:1`).join(', ')}
        </Row>
        <Row ok title={`Bleed ${report.canvas?.bleed_mm ?? 3} mm`}>
          The background runs into the bleed; text keeps inside the safe area.
        </Row>
        <Row ok={gamut.length === 0} title={gamut.length === 0 ? 'Colours print as they look' : 'Some colours will print duller'}>
          {gamut.length === 0 ? (
            'Nothing is brighter than ink can lay down.'
          ) : (
            <ul className="mt-1 flex flex-col gap-1">
              {gamut.map((g) => (
                <li key={g.role} className="flex flex-wrap items-center gap-1.5">
                  <span aria-hidden className="size-4 rounded-[3px] ring-1 ring-studio-border-strong" style={{ background: g.hex }} />
                  <span aria-hidden>→</span>
                  <span aria-hidden className="size-4 rounded-[3px] ring-1 ring-studio-border-strong" style={{ background: g.safe }} />
                  <span>
                    {g.role === 'ground' ? 'Background' : g.role === 'ink' ? 'Text' : 'Accent'} {g.hex} prints closer to {g.safe}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Row>
        {dropped.length > 0 && (
          <Row ok={false} title="Left out to keep the letters readable">
            {dropped.join(', ')}. A larger size, or reading from closer, makes room.
          </Row>
        )}
      </ul>
      <SwitchRow id={`${idBase}-overlay`} checked={overlay} onChange={onOverlay} title="Show trim and safe area" hint="Red: where it is cut. Blue: where text stays inside." />
      <SwitchRow id={`${idBase}-safe`} checked={printSafe} onChange={onPrintSafe} title="Print-safe colours" hint="Tone the flagged colours down to what prints." />
    </section>
  )
}
