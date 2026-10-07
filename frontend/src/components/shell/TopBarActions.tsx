import { createPortal } from 'react-dom'
import { useUi } from '@/stores/ui'

/** Renders a page's actions in the top bar (outside a project). Nothing shows until the slot mounts. */
export function TopBarActions({ children }: { children: React.ReactNode }) {
  const slot = useUi((s) => s.actionsSlot)
  return slot ? createPortal(children, slot) : null
}
