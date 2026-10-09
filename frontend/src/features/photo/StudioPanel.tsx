import type { ReactNode } from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

export type StudioTab = 'develop' | 'restore' | 'cutout' | 'looks'

const PANE = 'min-h-0 flex-1 overflow-y-auto px-3 pb-4 pt-2 focus-visible:outline-none'

/** Develop | Restore | Cut-out | Looks. */
export function StudioPanel({ tab, onTab, develop, restore, cutout, looks }: {
  tab: StudioTab
  onTab: (t: StudioTab) => void
  develop: ReactNode
  restore: ReactNode
  cutout: ReactNode
  looks: ReactNode
}) {
  return (
    <Tabs value={tab} onValueChange={(v) => onTab(v as StudioTab)} className="flex min-h-0 flex-1 flex-col">
      <TabsList aria-label="Photo Studio tools" className="flex-wrap border-b border-studio-border px-2 py-1.5">
        <TabsTrigger value="develop">Develop</TabsTrigger>
        <TabsTrigger value="restore">Restore</TabsTrigger>
        <TabsTrigger value="cutout">Cut-out</TabsTrigger>
        <TabsTrigger value="looks">Looks</TabsTrigger>
      </TabsList>
      <TabsContent value="develop" className={PANE}>{develop}</TabsContent>
      <TabsContent value="restore" className={PANE}>{restore}</TabsContent>
      <TabsContent value="cutout" className={PANE}>{cutout}</TabsContent>
      <TabsContent value="looks" className={PANE}>{looks}</TabsContent>
    </Tabs>
  )
}
