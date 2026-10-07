import { DropPasteOverlay, type DropTarget } from './DropPasteOverlay'

/** A create page: the dock on top of the results column (bottom sheet on phones), drop/paste anywhere. */
export function GeneratorPage({ label, targets, children }: { label: string; targets: DropTarget[]; children: React.ReactNode }) {
  return (
    <main data-f6-region tabIndex={-1} className="h-full overflow-y-auto focus-visible:outline-none" aria-label={label}>
      <div className="mx-auto flex min-h-full max-w-6xl flex-col gap-6 px-4 pt-4 md:px-8 md:pb-8 md:pt-6">{children}</div>
      <DropPasteOverlay targets={targets} />
    </main>
  )
}

export function ResultsHeading({ children }: { children: React.ReactNode }) {
  return <h2 className="section-label -mb-3">{children}</h2>
}
