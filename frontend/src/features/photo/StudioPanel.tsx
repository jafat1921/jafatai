import type { ReactNode } from 'react'
import { Crop, Scissors, SlidersHorizontal, Wand2 } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

// 'develop' and 'looks' keep their old names so ?tab= links and the session memory still work
export type StudioTab = 'develop' | 'crop' | 'restore' | 'cutout' | 'looks'

const PANE = 'min-h-0 flex-1 overflow-y-auto px-3 pb-4 pt-2 focus-visible:outline-none'

/** Lightroom's tool strip under the histogram: Edit, Crop (R), AI restore, Cut-out (masks come in D3). */
export function StudioPanel({ tab, onTab, top, develop, crop, restore, cutout, footer }: {
  tab: StudioTab
  onTab: (t: StudioTab) => void
  top: ReactNode
  develop: ReactNode
  crop: ReactNode
  restore: ReactNode
  cutout: ReactNode
  footer?: ReactNode
}) {
  const value = tab === 'looks' ? 'develop' : tab
  const item = (id: StudioTab, label: string, icon: ReactNode, hint: string) => (
    <TabsTrigger value={id} title={hint} className="flex-1 gap-1">
      {icon}
      {label}
    </TabsTrigger>
  )
  return (
    <Tabs value={value} onValueChange={(v) => onTab(v as StudioTab)} className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col gap-2 border-b border-studio-border px-3 pb-2 pt-2">
        {top}
        <TabsList aria-label="Tools" className="flex w-full">
          {item('develop', 'Edit', <SlidersHorizontal aria-hidden className="size-3.5" />, 'Edit panels')}
          {item('crop', 'Crop', <Crop aria-hidden className="size-3.5" />, 'Crop & straighten (R)')}
          {item('restore', 'AI', <Wand2 aria-hidden className="size-3.5" />, 'AI restore, Smart Restore, prompted fixes')}
          {item('cutout', 'Cut-out', <Scissors aria-hidden className="size-3.5" />, 'Remove or replace the background')}
        </TabsList>
      </div>
      <TabsContent value="develop" className={PANE}>{develop}</TabsContent>
      <TabsContent value="crop" className={PANE}>{crop}</TabsContent>
      <TabsContent value="restore" className={PANE}>{restore}</TabsContent>
      <TabsContent value="cutout" className={PANE}>{cutout}</TabsContent>
      {footer && <div className="border-t border-studio-border px-3 py-2">{footer}</div>}
    </Tabs>
  )
}
