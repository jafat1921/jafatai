import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import type { StageId } from '@/lib/stages'
import { useUi } from '@/stores/ui'
import { InspectorPanel } from './InspectorPanel'

// Below 1280 px the Inspector slides over the canvas. Non-modal, so the canvas stays clickable
// (e.g. picking another character while the portrait controls are open).
export function InspectorSheet({ stage }: { stage: StageId }) {
  const open = useUi((s) => s.inspectorOpen)
  const setOpen = useUi((s) => s.setInspectorOpen)
  return (
    <Sheet open={open} onOpenChange={setOpen} modal={false}>
      <SheetContent
        overlay={false}
        data-review-scope
        onInteractOutside={(e) => e.preventDefault()}
        style={{ top: 'var(--topbar-h)' }}
        className="w-[360px]"
      >
        <div className="border-b border-studio-border px-4 py-3">
          <SheetTitle className="section-label">Inspector</SheetTitle>
          <SheetDescription className="sr-only">Settings for the selected item</SheetDescription>
        </div>
        <div className="min-h-0 flex-1">
          <InspectorPanel stage={stage} />
        </div>
      </SheetContent>
    </Sheet>
  )
}
