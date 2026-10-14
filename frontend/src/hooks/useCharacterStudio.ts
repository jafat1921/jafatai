import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { BoardLayout, Character, CharacterSheet, PhotoConsentRecord, SheetCrop, SheetRequest, SheetTextPatch, TestClip } from '@/lib/types'
import { qk } from './keys'
import { upsertGeneration } from './useGenerations'
import { upsertJob } from './useJobs'

// contract-v25-character-sheets.md

export function useStudioCharacters(q = '') {
  return useQuery({ queryKey: qk.studioCharacters(q), queryFn: () => api.characters.studio(q) })
}

export function useCharacter(id: string | undefined) {
  return useQuery({ queryKey: qk.character(id ?? ''), queryFn: () => api.characters.get(id!), enabled: !!id })
}

const LIVE = new Set(['queued', 'generating', 'waiting'])

/** The sheet polls while panels or the board are being made; SSE covers single panels, not the board job. */
export function useCharacterSheet(id: string | undefined) {
  return useQuery({
    queryKey: qk.characterSheet(id ?? ''),
    queryFn: () => api.characters.sheet(id!),
    enabled: !!id,
    refetchInterval: (q) => {
      const s = q.state.data as CharacterSheet | undefined
      const busy = s && (s.panels.some((p) => LIVE.has(p.status)) || s.board.status === 'queued' || s.board.status === 'running')
      return busy ? 4000 : false
    },
  })
}

export function useSheetCatalogue() {
  return useQuery({ queryKey: qk.sheetCatalogue, queryFn: api.characters.catalogue, staleTime: Infinity })
}

function useCharacterCache() {
  const qc = useQueryClient()
  return (c: Character) => {
    qc.setQueryData(qk.character(c.id), c)
    qc.setQueriesData<Character[]>({ queryKey: ['characters'] }, (old) => old?.map((x) => (x.id === c.id ? { ...x, ...c } : x)))
  }
}

export function useSaveCharacter() {
  const put = useCharacterCache()
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string } & Parameters<typeof api.characters.update>[1]) => api.characters.update(id, body),
    onSuccess: put,
  })
}

export function useCreateStudioCharacter() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: api.characters.createStudio,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['characters', 'studio'] }),
  })
}

export function useCharacterFromPhoto() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: api.characters.fromPhoto,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['characters', 'studio'] }),
  })
}

export function useDeleteCharacter() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, projectId }: { id: string; projectId?: string }) => api.characters.remove(id, projectId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['characters'] }),
  })
}

export function useSaveToStudio() {
  const qc = useQueryClient()
  const put = useCharacterCache()
  return useMutation({
    mutationFn: api.characters.saveToStudio,
    onSuccess: (c) => {
      put(c)
      qc.invalidateQueries({ queryKey: ['characters', 'studio'] })
    },
  })
}

export function useLinkCharacter(projectId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (characterId: string) => api.characters.link(projectId, characterId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.characters(projectId) })
      qc.invalidateQueries({ queryKey: qk.project(projectId) })
    },
  })
}

export function useSheetActions(id: string) {
  const qc = useQueryClient()
  const set = (s: CharacterSheet) => qc.setQueryData(qk.characterSheet(id), s)
  const refresh = () => qc.invalidateQueries({ queryKey: qk.characterSheet(id) })
  return {
    make: useMutation({ mutationFn: (body: SheetRequest) => api.characters.makeSheet(id, body), onSuccess: set }),
    patch: useMutation({ mutationFn: (body: SheetTextPatch) => api.characters.patchSheet(id, body), onSuccess: set }),
    regenerate: useMutation({
      mutationFn: ({ key, note }: { key: string; note?: string }) => api.characters.regeneratePanel(id, key, note),
      onSuccess: (g) => {
        upsertGeneration(qc, g)
        refresh()
      },
    }),
    board: useMutation({ mutationFn: (layout: BoardLayout) => api.characters.makeBoard(id, layout), onSuccess: refresh }),
    // own images (contract v25)
    uploadSheet: useMutation({ mutationFn: (body: OwnImage) => api.characters.uploadSheet(id, body), onSuccess: set }),
    cut: useMutation({
      mutationFn: (crops: SheetCrop[]) => api.characters.cutSheet(id, crops),
      onSuccess: (s) => {
        set(s)
        // a crop for the portrait slot changes the character too
        qc.invalidateQueries({ queryKey: qk.character(id) })
        qc.invalidateQueries({ queryKey: qk.generationsFor('character', id, 'portrait') })
      },
    }),
    uploadPanel: useMutation({
      mutationFn: ({ key, ...body }: OwnImage & { key: string }) => api.characters.uploadPanel(id, key, body),
      onSuccess: (g) => {
        upsertGeneration(qc, g)
        refresh()
      },
    }),
  }
}

export type OwnImage = { media_id: string; consent?: PhotoConsentRecord }

/** "Upload portrait": a new portrait version, approved by the server only if none is yet. */
export function useUploadPortrait(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: OwnImage) => api.characters.uploadPortrait(id, body),
    onSuccess: (g) => {
      upsertGeneration(qc, g)
      qc.invalidateQueries({ queryKey: qk.character(id) })
      qc.invalidateQueries({ queryKey: qk.characterSheet(id) })
    },
  })
}

// `version` is the shot's updated_at, so a changed shot (type, text, characters) asks again
export function useShotRefs(shotId: string | undefined, version?: string) {
  return useQuery({
    queryKey: [...qk.shotRefs(shotId ?? ''), version ?? ''],
    queryFn: () => api.shots.refs(shotId!),
    enabled: !!shotId,
  })
}

// contract-v26-character-voices.md

/** "Design a voice for this character": a new Voices entry from the profile, set as the character's voice. */
export function useDesignCharacterVoice(id: string) {
  const qc = useQueryClient()
  const put = useCharacterCache()
  return useMutation({
    mutationFn: (body: { extra?: string } = {}) => api.characters.designVoice(id, body),
    onSuccess: (res) => {
      put(res.character)
      qc.invalidateQueries({ queryKey: qk.voiceLists })
    },
  })
}

const CLIP_LIVE = new Set(['queued', 'generating'])

/** The latest test clip; polled while its speech and its lip-synced render are still being made. */
export function useTestClip(id: string) {
  return useQuery({
    queryKey: qk.testClip(id),
    queryFn: () => api.characters.testClip(id),
    refetchInterval: (q) => {
      const status = (q.state.data as TestClip | undefined)?.item?.status
      return status && CLIP_LIVE.has(status) ? 3000 : false
    },
  })
}

export function useMakeTestClip(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (text: string) => api.characters.makeTestClip(id, text),
    onSuccess: (res) => {
      qc.setQueryData(qk.testClip(id), res)
      ;[res.job, ...(res.speech_jobs ?? [])].forEach((j) => j && upsertJob(qc, j))
    },
  })
}
