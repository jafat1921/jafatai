import { useState } from 'react'
import { usePromptEnhance } from '@/hooks/useGenEstimate'
import type { MagicFields, MagicMode, PromptEnhanceRequest } from '@/lib/types'

interface Draft {
  // the prompt it was made from; editing the prompt afterwards makes it stale
  from: string
  text: string
  changed: boolean
  notes?: string | null
  accepted: boolean
}

export interface MagicContext {
  kind: PromptEnhanceRequest['kind']
  model?: string
  style?: string | null
  brandKitId?: string
}

/** Magic prompt: Auto · On · Off, plus an on-demand preview the user can edit and accept. */
export function useMagicPrompt(prompt: string, ctx: MagicContext) {
  const [mode, setModeState] = useState<MagicMode>('auto')
  const [draft, setDraft] = useState<Draft | null>(null)
  const enhance = usePromptEnhance()
  const current = prompt.trim()
  const stale = !!draft && draft.from !== current

  const preview = () => {
    if (current.length < 3) return
    enhance.mutate(
      {
        prompt: current,
        kind: ctx.kind,
        mode: mode === 'off' ? 'on' : mode,
        ...(ctx.model ? { model: ctx.model } : {}),
        ...(ctx.style ? { style: ctx.style } : {}),
        ...(ctx.brandKitId ? { brand_kit_id: ctx.brandKitId } : {}),
      },
      { onSuccess: (r) => setDraft({ from: current, text: r?.enhanced || current, changed: !!r?.changed, notes: r?.notes, accepted: false }) },
    )
  }

  const setMode = (m: MagicMode) => {
    setModeState(m)
    if (m === 'off') setDraft(null)
  }

  /** The prompt and magic fields for the request body. */
  const fields = (): { prompt: string } & MagicFields => {
    if (draft?.accepted && !stale) return { prompt: draft.text.trim(), prompt_enhanced: true }
    // "auto" is the server default, so it isn't sent; older servers never see the field
    return mode === 'auto' ? { prompt: current } : { prompt: current, magic_prompt: mode }
  }

  return {
    mode,
    setMode,
    draft,
    stale,
    preview,
    previewing: enhance.isPending,
    error: enhance.error,
    edit: (text: string) => setDraft((d) => (d ? { ...d, text } : d)),
    accept: () => setDraft((d) => (d ? { ...d, accepted: true } : d)),
    undo: () => setDraft((d) => (d ? { ...d, accepted: false } : d)),
    discard: () => setDraft(null),
    fields,
    // the panel shows when there's something worth looking at
    showPanel: !!draft && (mode === 'on' || draft.changed || draft.accepted),
  }
}

export type MagicPrompt = ReturnType<typeof useMagicPrompt>
