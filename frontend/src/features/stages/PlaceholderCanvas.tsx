import { STAGES, type StageId } from '@/lib/stages'
import { EmptyState } from '@/components/studio/states'

const COPY: Partial<Record<StageId, { title: string; body: string; next: string }>> = {
  storyboard: {
    title: 'Storyboard arrives next',
    body: 'Each shot gets a START and END frame built from your approved cast, with Continue or Cut seams between shots.',
    next: 'Milestone 2',
  },
  render: {
    title: 'Render arrives after Storyboard',
    body: 'Approved frame pairs become video takes with LTX first/last-frame image-to-video, including 60-second long takes.',
    next: 'Milestone 3',
  },
  reel: {
    title: 'Reel arrives after Render',
    body: 'Lay out your chosen takes scene by scene, trim them, and set cuts and dissolves in a simple sequence.',
    next: 'Milestone 4',
  },
  output: {
    title: 'Output arrives last',
    body: 'Assemble the full film as a draft or final render, add chapters, and export EDL or XML for your editor.',
    next: 'Milestone 4',
  },
}

export function PlaceholderCanvas({ stage }: { stage: StageId }) {
  const meta = STAGES.find((s) => s.id === stage)!
  const copy = COPY[stage]
  return (
    <div className="flex h-full flex-col">
      <header className="px-5 pb-3 pt-4">
        <h1 className="text-title font-display font-semibold">{meta.label}</h1>
        <p className="text-small text-studio-muted">Not available yet</p>
      </header>
      <EmptyState className="flex-1" icon={<meta.icon />} title={copy?.title ?? meta.label}>
        {copy?.body}
        {copy && <span className="mt-2 block text-small text-studio-muted">Planned for {copy.next}.</span>}
      </EmptyState>
    </div>
  )
}
