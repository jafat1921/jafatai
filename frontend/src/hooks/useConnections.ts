import { useSystemStatus } from './useSystemStatus'

export type ConnectionState = 'ok' | 'down' | 'unknown'
type State = ConnectionState

export const stateWord = (s: State) => (s === 'ok' ? 'Connected' : s === 'down' ? 'Offline' : 'Checking')
const word = stateWord

/** Shared by the status chips, the rail's Settings dot and the Settings page. */
export function useConnections() {
  const { data, isError, error } = useSystemStatus()
  const comfy: State = isError ? 'down' : !data ? 'unknown' : data.comfy.ok ? 'ok' : 'down'
  const llm: State = isError ? 'down' : !data ? 'unknown' : data.llm.ok ? 'ok' : 'down'
  const failMsg = isError ? (error instanceof Error ? error.message : 'Status check failed') : null
  const comfyDetail =
    failMsg ??
    (data
      ? data.comfy.ok
        ? `${data.comfy.url}${data.comfy.version ? ` · v${data.comfy.version}` : ''}`
        : (data.comfy.error ?? 'Not reachable')
      : 'Checking…')
  const llmDetail =
    failMsg ??
    (data ? (data.llm.ok ? `${data.llm.url} · ${data.llm.models?.length ?? 0} models` : (data.llm.error ?? 'Not reachable')) : 'Checking…')
  const up = [comfy, llm].filter((s) => s === 'ok').length
  const overall: State = comfy === 'unknown' || llm === 'unknown' ? 'unknown' : up === 2 ? 'ok' : 'down'
  const label = overall === 'unknown' ? 'Checking' : up === 2 ? 'Online' : `${2 - up} offline`
  const summary = `ComfyUI ${word(comfy).toLowerCase()}, Ollama ${word(llm).toLowerCase()}`
  return { data, comfy, llm, comfyDetail, llmDetail, overall, label, summary, mock: data?.driver === 'mock' }
}


