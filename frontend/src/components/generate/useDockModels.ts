import { useModels } from '@/hooks/useModels'
import { AUTO_ID, guessAuto, modelToSend, pickModel, withAuto } from '@/lib/models'
import type { ModelInfo, ModelType } from '@/lib/types'

interface Opts {
  only?: (all: ModelInfo[]) => ModelInfo[]
  blocked?: (m: ModelInfo) => string | null
  // what Auto looks at
  prompt?: string
  count?: number
}

/**
 * The dock's model list: Auto first (and the default), then the catalog, optionally narrowed
 * (e.g. only models that can start from a picture). `send` is what the request should carry;
 * `effective` is the real model behind Auto, for limits and estimates.
 */
export function useDockModels(type: ModelType, chosenId: string | undefined, opts: Opts = {}) {
  const { models: raw } = useModels(type)
  const serverAutoEntry = raw.find((m) => m.id === AUTO_ID)
  const rest = raw.filter((m) => m.id !== AUTO_ID)
  const narrowed = opts.only ? opts.only(rest) : rest
  const { models, serverAuto } = withAuto(serverAutoEntry ? [serverAutoEntry, ...narrowed] : narrowed, type)
  const usable = opts.blocked ? models.filter((m) => !opts.blocked!(m)) : models
  const model = pickModel(usable, chosenId) ?? pickModel(models, chosenId)
  const ctx = { prompt: opts.prompt, count: opts.count }
  const send = modelToSend(type, usable, model, serverAuto, ctx)
  // for limits and the estimate: with Auto, the model it will most likely pick
  const effective = model?.id === AUTO_ID ? (guessAuto(type, usable, ctx) ?? model) : model
  return { models, model, send, effective, serverAuto }
}
