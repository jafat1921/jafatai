import type { ReactNode } from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

export type StudioTab = 'develop' | 'restore' | 'cutout' | 'looks'

const SOON = 'Coming next — needs the photo models on the server'

/** Develop | Restore | Cut-out | Looks. Restore and Cut-out are visible but off until M9b. */
export function StudioPanel({ tab, onTab, develop, looks }: { tab: StudioTab; onTab: (t: StudioTab) => void; develop: ReactNode; looks: ReactNode }) {
  return (
    <Tabs value={tab} onValueChange={(v) => onTab(v as StudioTab)} className="flex min-h-0 flex-1 flex-col">
      <TabsList aria-label="Photo Studio tools" className="flex-wrap border-b border-studio-border px-2 py-1.5">
        <TabsTrigger value="develop">Develop</TabsTrigger>
        <TabsTrigger value="restore" disabled title={SOON} aria-describedby="photo-soon" className="disabled:cursor-not-allowed disabled:opacity-60">
          Restore
        </TabsTrigger>
        <TabsTrigger value="cutout" disabled title={SOON} aria-describedby="photo-soon" className="disabled:cursor-not-allowed disabled:opacity-60">
          Cut-out
        </TabsTrigger>
        <TabsTrigger value="looks">Looks</TabsTrigger>
      </TabsList>
      <p id="photo-soon" className="px-3 pt-1.5 text-[12px] text-studio-muted">
        Restore and Cut-out · {SOON}
      </p>
      <TabsContent value="develop" className="min-h-0 flex-1 overflow-y-auto px-3 pb-4 pt-2 focus-visible:outline-none">
        {develop}
      </TabsContent>
      <TabsContent value="looks" className="min-h-0 flex-1 overflow-y-auto px-3 pb-4 pt-2 focus-visible:outline-none">
        {looks}
      </TabsContent>
    </Tabs>
  )
}
