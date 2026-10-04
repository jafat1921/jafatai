import { useSystemStatus } from '@/hooks/useSystemStatus'
import { Tooltip } from '@/components/ui/tooltip'
import { useUi } from '@/stores/ui'
import { cn } from '@/lib/utils'

type State = 'ok' | 'down' | 'unknown'

function Dot({ state }: { state: State }) {
  return (
    <span
      aria-hidden
      className={cn(
        'size-2 shrink-0 rounded-full',
        state === 'ok' && 'bg-studio-success',
        state === 'down' && 'bg-studio-danger',
        state === 'unknown' && 'bg-studio-faint',
      )}
    />
  )
}

const word = (s: State) => (s === 'ok' ? 'Connected' : s === 'down' ? 'Offline' : 'Checking')

function Indicator({ name, state, detail }: { name: string; state: State; detail: string }) {
  return (
    <Tooltip content={detail}>
      <span
        tabIndex={0}
        className="inline-flex items-center gap-1.5 rounded-[4px] px-1.5 py-1 text-small text-studio-muted hover:bg-studio-panel-hover"
        aria-label={`${name}: ${word(state)}. ${detail}`}
      >
        <Dot state={state} />
        <span className="text-studio-text">{name}</span>
        <span className={cn(state === 'down' && 'text-studio-danger')}>{word(state)}</span>
      </span>
    </Tooltip>
  )
}

export function ConnectionStatus({ compact }: { compact?: boolean }) {
  const { data, isError, error } = useSystemStatus()
  const sse = useUi((s) => s.sse)

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

  if (compact) {
    // one summary chip on narrow screens; still text, not colour alone
    const up = [comfy, llm].filter((s) => s === 'ok').length
    const overall: State = comfy === 'unknown' || llm === 'unknown' ? 'unknown' : up === 2 ? 'ok' : 'down'
    const label = overall === 'unknown' ? 'Checking' : up === 2 ? 'Online' : `${2 - up} offline`
    return (
      <Tooltip
        content={
          <span className="block">
            ComfyUI: {word(comfy)} — {comfyDetail}
            <br />
            Ollama: {word(llm)} — {llmDetail}
            {data?.driver === 'mock' && (
              <>
                <br />
                Mock renderer in use
              </>
            )}
          </span>
        }
      >
        <span
          tabIndex={0}
          className="inline-flex items-center gap-1.5 rounded-[4px] px-1.5 py-1 text-small text-studio-muted hover:bg-studio-panel-hover"
          aria-label={`Connections: ComfyUI ${word(comfy)}, Ollama ${word(llm)}`}
        >
          <Dot state={overall} />
          <span className={cn(overall === 'down' && 'text-studio-danger')}>{label}</span>
        </span>
      </Tooltip>
    )
  }

  return (
    <div className="flex items-center gap-0.5" role="group" aria-label="Connections">
      <Indicator name="ComfyUI" state={comfy} detail={comfyDetail} />
      <Indicator name="Ollama" state={llm} detail={llmDetail} />
      {data?.driver === 'mock' && (
        <span
          className="ml-1 hidden rounded-[4px] border border-studio-warning/50 px-1.5 text-small text-studio-warning 2xl:inline"
          title="Generations use the mock driver, not ComfyUI"
        >
          Mock renderer
        </span>
      )}
      {sse === 'connecting' && (
        <span className="ml-1 text-small text-studio-muted" title="Live updates are reconnecting">
          Reconnecting…
        </span>
      )}
    </div>
  )
}
