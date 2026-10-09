import type { StudioTab } from './StudioPanel'

// A finished step or save makes a new current version, which remounts the workspace. What the user
// was doing in it (the tab, a Smart Restore run) is kept per photo for the rest of the session.
export const lastTab = new Map<string, StudioTab>()
export const runningChains = new Map<string, { id: string; labels: string[] }>()

export function forgetPhotoSession() {
  lastTab.clear()
  runningChains.clear()
}
