import { readJSON, writeJSON } from './storage'

export type DockMode = 'simple' | 'advanced'

const KEY = 'mixai.dock'

// per user = per browser profile here; the server has no UI prefs yet
export const readDockMode = (): DockMode => (readJSON<{ mode: DockMode }>(KEY, { mode: 'simple' }).mode === 'advanced' ? 'advanced' : 'simple')
export const writeDockMode = (mode: DockMode) => writeJSON(KEY, { mode })
