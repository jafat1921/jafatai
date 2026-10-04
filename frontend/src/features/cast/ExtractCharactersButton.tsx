import { useCallback } from 'react'
import { api } from '@/lib/api'
import type { Job } from '@/lib/types'
import { AiExtractButton } from './AiExtractButton'

function found(noun: string) {
  return (job: Job) => {
    const r = job.result ?? {}
    const made = (r.created_ids as string[] | undefined)?.length ?? 0
    const sugg = r.suggestion_ids?.length ?? 0
    return `Found ${noun}: ${made} new${sugg ? `, ${sugg} description suggestion${sugg > 1 ? 's' : ''}` : ''}.`
  }
}

const characterSummary = found('characters')
const locationSummary = found('locations')

export function ExtractCharactersButton({ projectId, onError }: { projectId: string; onError: (e: unknown) => void }) {
  const start = useCallback(() => api.ai.extractCharacters(projectId), [projectId])
  return (
    <AiExtractButton
      projectId={projectId}
      start={start}
      label="Extract from script"
      hint="AI reads every scene and adds the characters it finds, with looks for image generation"
      summarize={characterSummary}
      onError={onError}
    />
  )
}

export function ExtractLocationsButton({ projectId, onError }: { projectId: string; onError: (e: unknown) => void }) {
  const start = useCallback(() => api.ai.extractLocations(projectId), [projectId])
  return (
    <AiExtractButton
      projectId={projectId}
      start={start}
      label="Extract locations"
      hint="AI reads the scene headings and script, adds the places it finds and links each scene to its location"
      summarize={locationSummary}
      onError={onError}
    />
  )
}
