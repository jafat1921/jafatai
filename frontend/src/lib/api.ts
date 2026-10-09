import type {
  AssistAction,
  Character,
  Generation,
  GenerationKind,
  Job,
  JobStatus,
  Location,
  Project,
  ProjectCreate,
  QuickRecent,
  QuickRequest,
  RegenerateMode,
  Reel,
  ReelClip,
  ReelClipPatch,
  ReelEstimate,
  Render,
  Scene,
  ScenePatch,
  Suggestion,
  Shot,
  ShotEstimate,
  ShotExtendResult,
  ShotRerenderResult,
  ShotsApproveResult,
  ShotPatch,
  ShotType,
  StitchRequest,
  StoryboardRequest,
  SuggestionResult,
  SystemStatus,
  TargetType,
  ImageUpscaleOptions,
  ImageUpscaleRequest,
  UpscaleOptions,
  UpscaleRequest,
  User,
  ComfyCheck,
  Dashboard,
  ImageEditRequest,
  ImageGenerateRequest,
  LlmCheck,
  MediaBatch,
  MediaDetail,
  MediaItem,
  MediaPage,
  MediaQuery,
  BatchAction,
  BatchResult,
  Folder,
  FolderKind,
  SavedFilter,
  Template,
  TemplateStart,
  ModelInfo,
  ModelType,
  TakesRequest,
  VideoGenerateRequest,
  Img2ImgRequest,
  EstimateQuery,
  EstimateResult,
  PromptEnhanceRequest,
  PromptEnhanceResult,
  MediaKind,
  UpscalePage,
} from './types'
import type { BrandKit, BrandKitPatch, LogoRevealRequest, PreviewKind } from './brand'
import type { CameraPreset } from './camera'
import type { MentionOption } from './mentions'
import type { Album, Client, Facets, PhotoPage } from './catalogue'
import type {
  AutoResult, Background, Described, DevelopParams, EffectSpec, Edge, ExportFormat, Histogram, ImportResult, Look, PhotoHistory, PhotoSchema, ProfileInfo,
  PlanStep, PreviewResult, RestoreRequest, RestoreTool, SmartPlan, Snapshot,
} from './photo/types'

type CameraPresets = Record<'shot_size' | 'angle' | 'motion' | 'speed', (CameraPreset<string> & { phrase: string })[]> & { default_speed: string }

export const API_BASE = '/api'

const UNREACHABLE = "Can't reach the studio server. Check that the backend is running."

export class ApiError extends Error {
  status: number
  detail: unknown

  constructor(status: number, message: string, detail?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.detail = detail
  }
}

export const isUnauthorized = (err: unknown) => err instanceof ApiError && err.status === 401

let unauthorizedHandler: (() => void) | null = null

// Wired once in main.tsx so a 401 anywhere drops the cached user and the auth guard redirects.
export function onUnauthorized(handler: (() => void) | null) {
  unauthorizedHandler = handler
}

// Login failing with 401 is a wrong password, not an expired session.
const NO_REDIRECT_ON_401 = ['/auth/login']

function messageFrom(status: number, body: unknown): string {
  const detail = (body as { detail?: unknown } | null)?.detail
  if (typeof detail === 'string') return detail
  // FastAPI 422: detail is [{loc, msg, type}]
  if (Array.isArray(detail)) {
    return detail
      .map((d) => {
        const field = Array.isArray(d?.loc) ? d.loc.filter((p: unknown) => p !== 'body').join('.') : ''
        return field ? `${field}: ${d.msg}` : String(d?.msg ?? '')
      })
      .join('; ')
  }
  // the dev proxy answers an empty 500/502 when the backend is down
  if (status >= 500 && (body === null || body === '')) return UNREACHABLE
  if (status >= 500) return 'The server hit a problem. Try again in a moment.'
  return `Request failed (${status})`
}

type Query = Record<string, string | number | boolean | null | undefined>

function withQuery(path: string, query?: Query) {
  if (!query) return path
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v))
  }
  const s = qs.toString()
  return s ? `${path}?${s}` : path
}

export async function request<T>(method: string, path: string, body?: unknown, query?: Query): Promise<T> {
  let res: Response
  try {
    res = await fetch(API_BASE + withQuery(path, query), {
      method,
      credentials: 'include',
      headers: body === undefined ? { Accept: 'application/json' } : { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new ApiError(0, UNREACHABLE)
  }

  if (res.status === 204) return undefined as T

  let parsed: unknown = null
  const text = await res.text()
  if (text) {
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = text
    }
  }

  if (!res.ok) {
    if (res.status === 401 && !NO_REDIRECT_ON_401.includes(path)) unauthorizedHandler?.()
    throw new ApiError(res.status, messageFrom(res.status, parsed), parsed)
  }
  return parsed as T
}

const get = <T>(path: string, query?: Query) => request<T>('GET', path, undefined, query)
const post = <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {})
const patch = <T>(path: string, body: unknown) => request<T>('PATCH', path, body)
const del = (path: string) => request<void>('DELETE', path)

async function postBlob(path: string, body: unknown): Promise<Blob> {
  let res: Response
  try {
    res = await fetch(API_BASE + path, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', Accept: 'image/png' },
      body: JSON.stringify(body),
    })
  } catch {
    throw new ApiError(0, UNREACHABLE)
  }
  if (!res.ok) {
    const text = await res.text()
    let parsed: unknown = text
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {
      /* plain text */
    }
    throw new ApiError(res.status, messageFrom(res.status, parsed), parsed)
  }
  return res.blob()
}

// raw fetch for the binary and multipart photo routes; same error shape as request()
async function send(path: string, init: RequestInit): Promise<Response> {
  let res: Response
  try {
    res = await fetch(API_BASE + path, { credentials: 'include', ...init })
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw e
    throw new ApiError(0, UNREACHABLE)
  }
  if (!res.ok) {
    const text = await res.text()
    let parsed: unknown = text
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {
      /* plain text */
    }
    if (res.status === 401) unauthorizedHandler?.()
    throw new ApiError(res.status, messageFrom(res.status, parsed), parsed)
  }
  return res
}

const jsonInit = (body: unknown, signal?: AbortSignal): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
  signal,
})

export interface GenerationQuery {
  target_type: TargetType
  target_id: string
  kind?: GenerationKind
  include_rejected?: boolean
}

export interface PhotoExif {
  captured_at: string | null
  camera: string | null
  lens: string | null
  focal_mm: number | null
  aperture: number | null
  shutter: string | null
  iso: number | null
  gps: { lat: number; lng: number } | null
  original_name: string | null
  bytes: number | null
  source_type: string | null
  width: number | null
  height: number | null
  tags: Record<string, string>
}

export const api = {
  auth: {
    login: (email: string, password: string) => post<User>('/auth/login', { email, password }),
    logout: () => post<void>('/auth/logout'),
    me: () => get<User>('/auth/me'),
    // dev-only prefill; the server answers {enabled:false} anywhere but a local dev run
    devLogin: () => get<{ enabled: boolean; email?: string; password?: string }>('/auth/dev-login'),
  },
  system: {
    status: () => get<SystemStatus>('/system/status'),
    upscaleOptions: () => get<UpscaleOptions>('/system/upscale-options'),
    comfyCheck: () => get<ComfyCheck>('/system/comfy-check'),
    // ping=true loads each role model in turn, so only on request
    llmCheck: (ping = false) => get<LlmCheck>('/system/llm-check', { ping }),
    imageUpscaleOptions: (generationId: string) =>
      get<ImageUpscaleOptions>(`/system/upscale-options?generation_id=${encodeURIComponent(generationId)}`),
  },
  projects: {
    list: () => get<Project[]>('/projects'),
    get: (id: string) => get<Project>(`/projects/${id}`),
    create: (body: ProjectCreate) => post<Project>('/projects', body),
    update: (id: string, body: Partial<Project>) => patch<Project>(`/projects/${id}`, body),
    remove: (id: string) => del(`/projects/${id}`),
    setBrandKit: (id: string, kitId: string | null) =>
      request<{ project_id: string; brand_kit_id: string | null }>('PUT', `/projects/${id}/brand-kit`, { kit_id: kitId }),
  },
  scenes: {
    list: (projectId: string) => get<Scene[]>(`/projects/${projectId}/scenes`),
    create: (
      projectId: string,
      body: { heading?: string; logline?: string; script_text?: string; after_scene_id?: string },
    ) => post<Scene>(`/projects/${projectId}/scenes`, body),
    update: (id: string, body: ScenePatch) => patch<Scene>(`/scenes/${id}`, body),
    reorder: (projectId: string, sceneIds: string[]) =>
      post<Scene[]>(`/projects/${projectId}/scenes/reorder`, { scene_ids: sceneIds }),
    remove: (id: string) => del(`/scenes/${id}`),
  },
  characters: {
    list: (projectId: string) => get<Character[]>(`/projects/${projectId}/characters`),
    create: (projectId: string, body: { name: string; description?: string }) =>
      post<Character>(`/projects/${projectId}/characters`, body),
    update: (id: string, body: Partial<Pick<Character, 'name' | 'description' | 'locked'>>) =>
      patch<Character>(`/characters/${id}`, body),
    remove: (id: string) => del(`/characters/${id}`),
  },
  locations: {
    list: (projectId: string) => get<Location[]>(`/projects/${projectId}/locations`),
    create: (projectId: string, body: { name: string; description?: string }) =>
      post<Location>(`/projects/${projectId}/locations`, body),
    update: (id: string, body: Partial<Pick<Location, 'name' | 'description' | 'locked' | 'time_of_day_variants'>>) =>
      patch<Location>(`/locations/${id}`, body),
    remove: (id: string) => del(`/locations/${id}`),
  },
  shots: {
    list: (projectId: string) => get<Shot[]>(`/projects/${projectId}/shots`),
    listForScene: (sceneId: string) => get<Shot[]>(`/scenes/${sceneId}/shots`),
    create: (
      sceneId: string,
      body: { shot_type?: ShotType; duration_s?: number; description?: string; after_shot_id?: string } = {},
    ) => post<Shot>(`/scenes/${sceneId}/shots`, body),
    update: (id: string, body: ShotPatch) => patch<Shot>(`/shots/${id}`, body),
    reorder: (sceneId: string, shotIds: string[]) => post<Shot[]>(`/scenes/${sceneId}/shots/reorder`, { shot_ids: shotIds }),
    remove: (id: string) => del(`/shots/${id}`),
    clearStale: (id: string) => post<Shot>(`/shots/${id}/clear-stale`),
    renderTakes: (id: string, { count, duration_s }: TakesRequest = {}) =>
      post<Job[]>(`/shots/${id}/takes`, {
        ...(count ? { count } : {}),
        ...(duration_s ? { duration_s } : {}),
      }),
    estimate: (id: string, durationS?: number) => get<ShotEstimate>(`/shots/${id}/estimate`, { duration_s: durationS }),
    renderScene: (sceneId: string, count?: number) => post<Job[]>(`/scenes/${sceneId}/render`, count ? { count } : {}),
    // UI polish P3
    merge: (shotIds: string[]) => post<Shot[]>('/shots/merge', { shot_ids: shotIds }),
    split: (id: string, body: { at_ratio?: number; descriptions?: [string, string] } = {}) =>
      post<Shot[]>(`/shots/${id}/split`, body),
    extend: (id: string, body: { duration_s?: number; prompt?: string } = {}) =>
      post<ShotExtendResult>(`/shots/${id}/extend`, body),
    rerender: (id: string, body: { what: 'frames' | 'takes'; count?: number; params?: Record<string, unknown> }) =>
      post<ShotRerenderResult>(`/shots/${id}/rerender`, body),
    setReview: (sceneId: string, status: 'pending' | null) => patch<Scene>(`/scenes/${sceneId}/shots-review`, { status }),
    approveShotList: (sceneId: string, params?: Record<string, unknown>) =>
      post<ShotsApproveResult>(`/scenes/${sceneId}/shots-review/approve`, { generate_frames: true, ...(params ? { params } : {}) }),
  },
  storyboard: {
    fromScript: (projectId: string, body: StoryboardRequest) => post<Job>(`/projects/${projectId}/storyboard`, body),
  },
  generations: {
    list: (q: GenerationQuery) => get<Generation[]>('/generations', { ...q }),
    create: (body: {
      target_type: TargetType
      target_id: string
      kind: GenerationKind
      prompt: string
      params?: Record<string, unknown>
    }) => post<Generation>('/generations', body),
    regenerate: (
      id: string,
      body: { mode: RegenerateMode; note?: string; prompt?: string; params?: Record<string, unknown> },
    ) => post<Generation>(`/generations/${id}/regenerate`, body),
    approve: (id: string) => post<Generation>(`/generations/${id}/approve`),
    unapprove: (id: string) => post<Generation>(`/generations/${id}/unapprove`),
    reject: (id: string, reason?: string) => post<Generation>(`/generations/${id}/reject`, reason ? { reason } : {}),
    restore: (id: string) => post<Generation>(`/generations/${id}/restore`),
    regenerateChunk: (id: string, idx: number, body: { prompt?: string; seed?: number } = {}) =>
      post<Job>(`/generations/${id}/chunks/${idx}/regenerate`, body),
    upscale: (id: string, body: UpscaleRequest | ImageUpscaleRequest) => post<Job>(`/generations/${id}/upscale`, body),
    get: (id: string) => get<Generation>(`/generations/${id}`),
  },
  reel: {
    get: (projectId: string) => get<Reel>(`/projects/${projectId}/reel`),
    sync: (projectId: string) => post<Reel>(`/projects/${projectId}/reel/sync`),
    updateClip: (id: string, body: ReelClipPatch) => patch<ReelClip>(`/reel-clips/${id}`, body),
    reorder: (projectId: string, clipIds: string[]) => post<Reel>(`/projects/${projectId}/reel/reorder`, { clip_ids: clipIds }),
    assemble: (projectId: string, body: StitchRequest = { quality: 'draft' }) =>
      post<Job>(`/projects/${projectId}/reel/assemble`, body),
    renders: (projectId: string) => get<Render[]>(`/projects/${projectId}/renders`),
    rename: (renderId: string, title: string) => patch<Render>(`/generations/${renderId}`, { title }),
    // a plain link: the browser streams the file and names it from Content-Disposition
    downloadUrl: (generationId: string) => `${API_BASE}/generations/${generationId}/download`,
    estimate: (projectId: string) => get<ReelEstimate>(`/projects/${projectId}/reel/estimate`),
  },
  ai: {
    outline: (projectId: string) => post<Job>(`/projects/${projectId}/ai/outline`),
    writeMissing: (projectId: string, body: { scene_ids?: string[]; after_scene_id?: string; count?: number } = {}) =>
      post<Job>(`/projects/${projectId}/ai/write-missing`, body),
    continueStory: (projectId: string, count = 1) => post<Job>(`/projects/${projectId}/ai/continue`, { count }),
    extractCharacters: (projectId: string) => post<Job>(`/projects/${projectId}/ai/extract-characters`),
    assist: (sceneId: string, body: { action: AssistAction; idea?: string; tone?: string }) =>
      post<Job>(`/scenes/${sceneId}/ai/assist`, body),
    extractLocations: (projectId: string) => post<Job>(`/projects/${projectId}/ai/extract-locations`),
    suggestShots: (sceneId: string, maxShots?: number, reviewFirst?: boolean) =>
      post<Job>(`/scenes/${sceneId}/ai/suggest-shots`, {
        ...(maxShots ? { max_shots: maxShots } : {}),
        ...(reviewFirst ? { review_first: true } : {}),
      }),
    compilePrompts: (shotId: string) => post<Job>(`/shots/${shotId}/ai/compile-prompts`),
    beats: (shotId: string) => post<Job>(`/shots/${shotId}/ai/beats`),
    portraitPrompt: (characterId: string) => post<Job>(`/characters/${characterId}/ai/portrait-prompt`),
    suggestions: (projectId: string) => get<Suggestion[]>(`/projects/${projectId}/suggestions`, { status: 'pending' }),
    accept: (id: string) => post<SuggestionResult>(`/suggestions/${id}/accept`),
    reject: (id: string) => post<SuggestionResult>(`/suggestions/${id}/reject`),
  },
  quick: {
    create: (body: QuickRequest) => post<{ project: Project; job: Job }>('/quick', body),
    recent: () => get<QuickRecent[]>('/quick/recent'),
  },
  // contract-v5: the Library behind the Image and Video sections
  media: {
    list: (q: MediaQuery = {}) => get<MediaPage>('/media', { ...q }),
    get: (id: string) => get<MediaDetail>(`/media/${id}`),
    update: (id: string, body: { title?: string; tags?: string[] }) => patch<MediaItem>(`/media/${id}`, body),
    remove: (id: string) => del(`/media/${id}`),
    move: (refs: string[], folderId: string | null) => post<BatchResult>('/media/move', { refs, folder_id: folderId }),
    batch: (action: BatchAction, refs: string[], options: Record<string, unknown> = {}) => post<BatchResult>('/media/batch', { action, refs, options }),
    regenerate: (id: string, body: { mode: RegenerateMode; note?: string; prompt?: string }) =>
      post<Job>(`/media/${id}/regenerate`, body),
    // upload goes through lib/upload.ts (XHR, for progress)
  },
  photos: {
    list: (q: Record<string, string | number | boolean | undefined>) => get<PhotoPage>('/photos', q),
    facets: (q: Record<string, string | number | boolean | undefined>) => get<Facets>('/photos/facets', q),
    neighbours: (id: string, q: Record<string, string | number | boolean | undefined>) =>
      get<{ ids: string[]; index: number | null; position?: number; total: number; prev?: string | null; next?: string | null }>(`/photos/${id}/neighbours`, q),
    marks: (body: { ids: string[]; rating?: number; flag?: 'pick' | 'reject' | 'none'; label?: string }) =>
      post<{ updated: number }>('/photos/marks', body),
    update: (id: string, body: { title?: string; caption?: string; keywords?: string[] }) => patch<MediaItem>(`/photos/${id}`, body),
    exif: (id: string) => get<PhotoExif>(`/photos/${id}/exif`),
    sourceUrl: (id: string) => `${API_BASE}/photos/${id}/source`,
  },
  albums: {
    list: () => get<Album[]>('/albums'),
    create: (body: Partial<Album> & { name: string; kind: Album['kind'] }) => post<Album>('/albums', body),
    update: (id: string, body: Partial<Album>) => patch<Album>(`/albums/${id}`, body),
    remove: (id: string) => del(`/albums/${id}`),
    items: (id: string, ids: string[], action: 'add' | 'remove' = 'add') =>
      post<{ changed: number; album: Album }>(`/albums/${id}/items`, { ids, action }),
    order: (id: string, ids: string[]) => post<void>(`/albums/${id}/order`, { ids }),
  },
  clients: {
    list: () => get<Client[]>('/clients'),
    create: (body: Pick<Client, 'name'> & Partial<Pick<Client, 'email' | 'phone' | 'notes'>>) => post<Client>('/clients', body),
    update: (id: string, body: Partial<Pick<Client, 'name' | 'email' | 'phone' | 'notes'>>) => patch<Client>(`/clients/${id}`, body),
    remove: (id: string) => del(`/clients/${id}`),
  },
  upscales: {
    list: (q: { kind?: MediaKind; limit?: number; cursor?: string }) => get<UpscalePage>('/upscales', { ...q }),
    remove: (generationId: string) => del(`/upscales/${generationId}`),
  },
  images: {
    generate: (body: ImageGenerateRequest) => post<MediaBatch>('/images/generate', body),
    edit: (body: ImageEditRequest) => post<MediaBatch>('/images/edit', body),
    img2img: (body: Img2ImgRequest) => post<MediaBatch>('/images/img2img', body),
  },
  // contract-v6
  models: {
    list: (type: ModelType) => get<ModelInfo[]>('/models', { type }),
  },
  videos: {
    // a MediaItem plus its job; tolerate a batch too
    generate: (body: VideoGenerateRequest) => post<(MediaItem & { job?: Job | null }) | MediaBatch>('/videos/generate', body),
  },
  // contract-v8 P2
  mentions: {
    search: (q: { q?: string; project_id?: string; types?: string; kit_id?: string }) => get<MentionOption[]>('/mentions', q),
  },
  camera: {
    presets: () => get<CameraPresets>('/camera/presets'),
  },
  // contract-v7
  brandKits: {
    list: () => get<BrandKit[]>('/brand-kits'),
    get: (id: string) => get<BrandKit>(`/brand-kits/${id}`),
    create: (body: BrandKitPatch & { name: string; is_default?: boolean }) => post<BrandKit>('/brand-kits', body),
    update: (id: string, body: BrandKitPatch) => patch<BrandKit>(`/brand-kits/${id}`, body),
    remove: (id: string) => del(`/brand-kits/${id}`),
    setDefault: (id: string) => post<BrandKit>(`/brand-kits/${id}/default`),
    // synchronous PNG; settings carry the editor's unsaved changes
    preview: (id: string, body: { kind: PreviewKind; sample_media_id?: string; settings?: unknown }) => postBlob(`/brand-kits/${id}/preview`, body),
    logoReveal: (id: string, body: LogoRevealRequest) => post<{ item: MediaItem; job: Job }>(`/brand-kits/${id}/logo-reveal`, body),
  },
  templates: {
    list: (type: 'video' | 'image') => get<Template[]>('/prompt-templates', { type }),
    start: (id: string) => post<TemplateStart>(`/prompt-templates/${id}/start`),
  },
  // contract-v9: Photo Studio
  photo: {
    schema: () => get<PhotoSchema>('/photo/schema'),
    preview: async (id: string, params: DevelopParams, maxSide = 1280, signal?: AbortSignal): Promise<PreviewResult> => {
      const res = await send(`/photo/${id}/preview`, jsonInit({ params, max_side: maxSide }, signal))
      const ms = Number(res.headers.get('X-Develop-Ms'))
      return { url: URL.createObjectURL(await res.blob()), ms: Number.isFinite(ms) && ms > 0 ? ms : null, outputSize: res.headers.get('X-Output-Size') }
    },
    histogram: (id: string, params: DevelopParams) => post<Histogram>(`/photo/${id}/histogram`, { params }),
    auto: (id: string) => post<AutoResult>(`/photo/${id}/auto`),
    palette: (id: string, k = 8) => get<{ clusters: NonNullable<DevelopParams['palette']> }>(`/photo/${id}/palette`, { k }),
    render: (id: string, body: { params: DevelopParams; format?: ExportFormat; quality?: number; note?: string }) =>
      post<Job>(`/photo/${id}/render`, body),
    history: (id: string) => get<PhotoHistory>(`/photo/${id}/history`),
    revert: (id: string) => post<PhotoHistory>(`/photo/${id}/revert`),
    cube: async (params: DevelopParams, title: string, size = 33) => (await send('/photo/cube', jsonInit({ params, size, title }))).blob(),
    tools: () => get<{ tools: RestoreTool[]; effects: EffectSpec[] }>('/photo/tools'),
    smartPlan: (id: string) => get<SmartPlan>(`/photo/${id}/smart-plan`),
    smartRestore: (id: string, steps: Pick<PlanStep, 'tool' | 'on' | 'variant' | 'strength'>[]) =>
      post<{ chain_id: string; steps: { tool: string; label: string }[]; first_job_id: string }>(`/photo/${id}/smart-restore`, { steps }),
    restore: (id: string, body: RestoreRequest) => post<Job>(`/photo/${id}/restore`, body),
    effect: (id: string, name: string, strength = 1) => post<Job>(`/photo/${id}/effect`, { name, strength, format: 'png' }),
    background: (id: string, background: Background, edge?: Edge) => post<Job>(`/photo/${id}/background`, { background, edge }),
    maskUrl: (id: string) => `${API_BASE}/photo/${id}/mask`,
    describe: (id: string) => post<Described>(`/photo/${id}/describe`),
    snapshots: (id: string) => get<Snapshot[]>(`/photo/${id}/snapshots`),
    createSnapshot: (id: string, body: { name: string; params: DevelopParams; base_id?: string }) => post<Snapshot>(`/photo/${id}/snapshots`, body),
    updateSnapshot: (sid: string, body: { name?: string; params?: DevelopParams }) => patch<Snapshot>(`/photo/snapshots/${sid}`, body),
    deleteSnapshot: (sid: string) => del(`/photo/snapshots/${sid}`),
    profiles: () => get<ProfileInfo[]>('/photo/profiles'),
    // a 3D table for the WebGL preview: size³ RGB bytes, red fastest
    lut: async (kind: 'profile' | 'look', id: string) => {
      const t = await get<{ size: number; data: string }>(`/photo/luts/${kind}/${encodeURIComponent(id)}`)
      return { size: t.size, data: Uint8Array.from(atob(t.data), (c) => c.charCodeAt(0)) }
    },
    sync: (body: { ids: string[]; params: DevelopParams; groups: string[]; format?: ExportFormat }) =>
      post<{ queued: number; results: { id: string; job_id: string | null; error: string | null; unchanged?: boolean }[] }>('/photo/sync', body),
  },
  looks: {
    list: () => get<Look[]>('/looks'),
    create: (body: { name: string; params: DevelopParams; description?: string; category?: string; generation_id?: string }) =>
      post<Look>('/looks', body),
    update: (id: string, body: { name?: string; params?: DevelopParams; description?: string; category?: string }) => patch<Look>(`/looks/${id}`, body),
    remove: (id: string) => del(`/looks/${id}`),
    importFiles: async (files: File[]): Promise<ImportResult> => {
      const form = new FormData()
      files.forEach((f) => form.append('files', f, f.name))
      try {
        return (await (await send('/looks/import', { method: 'POST', body: form })).json()) as ImportResult
      } catch (e) {
        // a 422 still carries the per-file reports
        const detail = (e as ApiError).detail as Partial<ImportResult> | { detail?: Partial<ImportResult> } | undefined
        const reports = (detail as Partial<ImportResult>)?.reports ?? (detail as { detail?: Partial<ImportResult> })?.detail?.reports
        if (e instanceof ApiError && e.status === 422 && reports) return { looks: [], reports }
        throw e
      }
    },
    cubeUrl: (id: string, size = 33) => `${API_BASE}/looks/${id}/cube?size=${size}`,
    thumbUrl: (id: string, generationId?: string) =>
      `${API_BASE}/looks/${id}/thumb${generationId ? `?generation_id=${encodeURIComponent(generationId)}` : ''}`,
    applyVideo: (id: string, body: { generation_id: string; intensity: number }) => post<Job>(`/looks/${id}/apply-video`, body),
  },
  dashboard: () => get<Dashboard>('/dashboard'),
  // contract-v8 P4: library organisation
  folders: {
    list: (kind?: 'image' | 'video') => get<Folder[]>('/folders', kind ? { kind } : undefined),
    create: (body: { name: string; parent_id?: string | null; kind?: FolderKind }) => post<Folder>('/folders', body),
    update: (id: string, body: { name?: string; parent_id?: string; sort?: number }) => patch<Folder>(`/folders/${id}`, body),
    remove: (id: string) => del(`/folders/${id}`),
  },
  favourites: {
    list: () => get<{ refs: string[] }>('/favourites'),
    toggle: (ref: string, on?: boolean) => post<{ ref: string; favourite: boolean }>('/favourites/toggle', on == null ? { ref } : { ref, on }),
    import: (refs: string[]) => post<{ refs: string[]; imported: number; skipped: number }>('/favourites/import', { refs }),
  },
  savedFilters: {
    list: () => get<SavedFilter[]>('/saved-filters'),
    create: (body: { name: string; query: Record<string, unknown> }) => post<SavedFilter>('/saved-filters', body),
    remove: (id: string) => del(`/saved-filters/${id}`),
  },
  exportUrl: (jobId: string) => `${API_BASE}/exports/${jobId}/download`,
  // P1 polish; both answer 404 on servers that predate them
  prompts: {
    enhance: (body: PromptEnhanceRequest) => post<PromptEnhanceResult>('/prompts/enhance', body),
  },
  estimate: (q: EstimateQuery) => get<EstimateResult>('/estimate', { ...q }),
  jobs: {
    list: (q?: { status?: JobStatus; project_id?: string }) => get<Job[]>('/jobs', q),
    cancel: (id: string) => post<Job>(`/jobs/${id}/cancel`),
    retry: (id: string) => post<Job>(`/jobs/${id}/retry`),
  },
}
