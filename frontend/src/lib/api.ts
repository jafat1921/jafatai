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
} from './types'
import type { BrandKit, BrandKitPatch, LogoRevealRequest, PreviewKind } from './brand'

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

export interface GenerationQuery {
  target_type: TargetType
  target_id: string
  kind?: GenerationKind
  include_rejected?: boolean
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
    suggestShots: (sceneId: string, maxShots?: number) =>
      post<Job>(`/scenes/${sceneId}/ai/suggest-shots`, maxShots ? { max_shots: maxShots } : {}),
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
    regenerate: (id: string, body: { mode: RegenerateMode; note?: string; prompt?: string }) =>
      post<Job>(`/media/${id}/regenerate`, body),
    // upload goes through lib/upload.ts (XHR, for progress)
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
    list: (type: 'video' | 'image') => get<Template[]>('/templates', { type }),
    start: (id: string) => post<TemplateStart>(`/templates/${id}/start`),
  },
  dashboard: () => get<Dashboard>('/dashboard'),
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
