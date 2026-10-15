import { useId } from 'react'
import { fieldClass } from '@/components/ui/input'
import type { ImageToolInfo, LightFrom, TemplateTool } from '@/lib/types'
import { cn } from '@/lib/utils'

const LIGHTS: { value: LightFrom; label: string }[] = [
  { value: 'none', label: 'From the prompt' },
  { value: 'left', label: 'Left' },
  { value: 'right', label: 'Right' },
  { value: 'top', label: 'Above' },
  { value: 'bottom', label: 'Below' },
]

interface Props {
  tool: TemplateTool
  // undefined while /images/tools loads; null when the server doesn't list it (switched off)
  info: ImageToolInfo | null | undefined
  useTool: boolean
  onUseTool: (on: boolean) => void
  light: LightFrom
  onLight: (v: LightFrom) => void
}

/** Which engine an edit template runs on: a dedicated tool or the edit model. */
export function ToolChoice({ tool, info, useTool, onUseTool, light, onLight }: Props) {
  const uid = useId()
  const ready = !!info?.available
  const why = info === null ? 'switched off on this server' : info?.reason
  let status: string
  if (info === undefined) status = `Checking whether ${tool.engine} is installed…`
  else if (!ready) status = tool.fallback ? `${tool.engine} isn't available (${why}), so the edit model runs this instead.` : `${tool.engine} isn't available: ${why}.`
  else if (!useTool) status = 'Runs on the edit model, from your instruction.'
  else if (tool.needs_mask) status = `Runs on ${tool.engine} where you paint a mask; with no mask the edit model removes what you name.`
  else status = `Runs on ${tool.engine}.`

  return (
    <div role="group" aria-label="Engine for this template" className="flex flex-col gap-2 rounded-[6px] border border-studio-border bg-studio-raised px-2.5 py-2">
      <p className="text-small" role="status">
        {status}
      </p>
      <p className="text-[12px] text-studio-muted">Runs on {tool.engine}</p>
      {ready && tool.fallback && (
        <fieldset className="flex flex-wrap items-center gap-3">
          <legend className="sr-only">Engine</legend>
          <label className="flex items-center gap-1.5 text-small">
            <input type="radio" name={`${uid}-engine`} checked={useTool} onChange={() => onUseTool(true)} className="accent-studio-accent" />
            {tool.engine}
          </label>
          <label className="flex items-center gap-1.5 text-small">
            <input type="radio" name={`${uid}-engine`} checked={!useTool} onChange={() => onUseTool(false)} className="accent-studio-accent" />
            Edit model (Qwen-Image-Edit)
          </label>
        </fieldset>
      )}
      {ready && useTool && tool.id === 'relight' && (
        <div className="flex items-center gap-2">
          <label htmlFor={`${uid}-light`} className="text-small font-medium">
            Light from
          </label>
          <select id={`${uid}-light`} value={light} onChange={(e) => onLight(e.target.value as LightFrom)} className={cn(fieldClass, 'h-8 w-auto py-0 pr-7 text-small')}>
            {LIGHTS.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  )
}
