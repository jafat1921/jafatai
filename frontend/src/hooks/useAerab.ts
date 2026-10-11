import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { api, ApiError } from '@/lib/api'
import { aerabNote, hasArabicScript, isArabicScriptLang } from '@/lib/aerab'
import type { TextAerabRequest } from '@/lib/types'
import { announce } from '@/stores/ui'

export function aerabError(e: unknown) {
  if (e instanceof ApiError && e.status === 503) return "Aerab is offline: the studio's language model isn't answering. Try again in a minute."
  if (e instanceof ApiError && e.status === 422) return 'There are no Urdu, Arabic or other Arabic-script lines to mark.'
  return e instanceof Error ? e.message : "Couldn't add aerab just now."
}

interface Options {
  text: string
  onText: (next: string) => void
  // the editor's language; anything not Arabic-script lets the server read the letters
  language?: string | null
  max?: number
}

/** "Add aerab" for one text field: POST /text/aerab, one-step undo, and a result line to show and announce. */
export function useAerab({ text, onText, language, max }: Options) {
  // undo only while the text is still what the marking produced; typing since makes it the writer's again
  const [undo, setUndo] = useState<{ before: string; after: string } | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const marking = useMutation({ mutationFn: (body: TextAerabRequest) => api.text.aerab(body) })

  const say = (msg: string) => {
    setNote(msg)
    announce(msg)
  }

  const run = () => {
    if (marking.isPending || !text.trim()) return
    marking.mutate(
      { text, ...(isArabicScriptLang(language) ? { language: language as string } : {}) },
      {
        onSuccess: (res) => {
          const next = max ? res.text.slice(0, max) : res.text
          if (next !== text) {
            setUndo({ before: text, after: next })
            onText(next)
          }
          say(aerabNote(res.marked, res.kept, res.low_coverage))
        },
        onError: (e) => say(aerabError(e)),
      },
    )
  }

  const revert = () => {
    if (!undo) return
    onText(undo.before)
    setUndo(null)
    say('Aerab removed: the text is back as you wrote it.')
  }

  return {
    run,
    undo: revert,
    canUndo: undo !== null && undo.after === text,
    pending: marking.isPending,
    note,
    visible: hasArabicScript(text),
  }
}
