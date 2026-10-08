// localStorage can throw (private mode, quota, disabled cookies) — never let that break the UI.
export function readJSON<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return fallback
    const parsed = JSON.parse(raw)
    // lists are stored whole; merging them into an object would turn them into {0: …, 1: …}
    if (Array.isArray(fallback)) return (Array.isArray(parsed) ? parsed : fallback) as T
    return { ...fallback, ...parsed }
  } catch {
    return fallback
  }
}

export function writeJSON(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* ignore */
  }
}
