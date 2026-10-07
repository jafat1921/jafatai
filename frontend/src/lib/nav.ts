import {
  Boxes,
  Brush,
  Clapperboard,
  Film,
  FolderUp,
  Home,
  ImageIcon,
  ImageUpscale,
  Images,
  LayoutTemplate,
  ListOrdered,
  MapPin,
  Maximize2,
  Settings,
  Shuffle,
  Stamp,
  UserRound,
  Users,
  Video,
  Wand2,
  Layers,
  type LucideIcon,
} from 'lucide-react'

import { FALLBACK_MODELS } from './models'
import type { ModelBadgeId, ModelInfo, ModelType } from './types'

// docs/design/navigation.md, revision 2. Only models wired into the backend are listed.

export type Badge = ModelBadgeId

export interface Feature {
  id: string
  title: string
  description: string
  to: string
  icon: LucideIcon
  disabled?: boolean
}

export interface Model {
  id: string
  name: string
  badge?: Badge | null
  description: string
  to: string
  mark: string
  // upscale engines: the catalog entry that decides whether it's listed
  catalogId?: string
}

export interface MenuSection {
  title: string
  features: Feature[]
  models: Model[]
  modelsNote?: string
}

export type RailId = 'home' | 'assets' | 'brand' | 'image' | 'video' | 'upscale' | 'queue' | 'settings'

export interface RailItem {
  id: RailId
  label: string
  icon: LucideIcon
  to: string
  menu?: MenuSection
}

const IMAGE_MENU: MenuSection = {
  title: 'Image Tools',
  features: [
    { id: 'create', title: 'Create Image', description: 'Generate images from text', to: '/image/generate', icon: Wand2 },
    { id: 'edit', title: 'Edit Image', description: 'Change an image with words', to: '/image/edit', icon: Brush },
    { id: 'img2img', title: 'Image to Image', description: 'Restyle or vary your picture', to: '/image/img2img', icon: Shuffle },
    { id: 'refs', title: 'References', description: 'Keep a face, product or style', to: '/image/references', icon: Layers },
    { id: 'upscale', title: 'Image Upscale', description: 'Sharper, bigger, 2× to 4K', to: '/image/upscale', icon: ImageUpscale },
    { id: 'templates', title: 'Templates', description: 'Portrait, product, poster…', to: '/image/templates', icon: LayoutTemplate },
    { id: 'library', title: 'Library', description: 'All your images', to: '/image/library', icon: Images },
  ],
  models: [
    { id: 'seedvr2', catalogId: 'seedvr2', name: 'SeedVR2 3B / 7B', badge: 'UPSCALE', description: 'Faithful restoration', to: '/image/upscale?engine=best', mark: 'S' },
    { id: 'realesrgan', catalogId: 'esrgan', name: 'Real-ESRGAN ×4', badge: 'QUICK', description: 'Fast enlargement', to: '/image/upscale?engine=quick', mark: 'R' },
  ],
}

const VIDEO_MENU: MenuSection = {
  title: 'Video Tools',
  features: [
    { id: 'create', title: 'Create Video', description: 'One prompt, one clip', to: '/video/create', icon: Video },
    { id: 'img2vid', title: 'Image to Video', description: 'Animate your picture', to: '/video/img2vid', icon: Film },
    { id: 'quick', title: 'Quick Video', description: 'One prompt, a finished video', to: '/video/quick', icon: Wand2 },
    { id: 'projects', title: 'Studio Projects', description: 'Script, cast, storyboard, render', to: '/video/projects', icon: Clapperboard },
    { id: 'templates', title: 'Templates', description: 'Product ad, documentary, teaser…', to: '/video/templates', icon: LayoutTemplate },
    { id: 'upscale', title: 'Video Upscale', description: 'Sharper video, up to 4K', to: '/video/upscale', icon: Maximize2 },
    { id: 'library', title: 'Library', description: 'Every finished video', to: '/video/library', icon: Film },
  ],
  models: [
    { id: 'seedvr2', catalogId: 'seedvr2', name: 'SeedVR2', badge: 'BEST', description: 'Best upscale, steady detail', to: '/video/upscale?engine=best', mark: 'S' },
    { id: 'flashvsr', catalogId: 'flashvsr', name: 'FlashVSR 1.1', badge: 'FAST', description: 'Fast upscale', to: '/video/upscale?engine=fast', mark: 'F' },
  ],
}

const UPSCALE_MENU: MenuSection = {
  title: 'Upscale',
  features: [
    { id: 'image', title: 'Upscale Image', description: 'Upload or pick from your library', to: '/image/upscale', icon: ImageUpscale },
    { id: 'video', title: 'Upscale Video', description: 'Upload or pick from your library', to: '/video/upscale', icon: Maximize2 },
  ],
  models: [
    { id: 'seedvr2-video', catalogId: 'seedvr2', name: 'SeedVR2 · video', badge: 'BEST', description: 'Sharpest motion detail, the slowest', to: '/video/upscale?engine=best', mark: 'S' },
    { id: 'flashvsr', catalogId: 'flashvsr', name: 'FlashVSR 1.1 · video', badge: 'FAST', description: 'Good detail in a fraction of the time', to: '/video/upscale?engine=fast', mark: 'F' },
    { id: 'zimage-redraw', catalogId: 'zimage_redraw', name: 'Z-Image redraw · image', badge: 'UPSCALE', description: 'Repaints fine texture, adds detail', to: '/image/upscale?engine=redraw', mark: 'Z' },
    { id: 'seedvr2-image', catalogId: 'seedvr2', name: 'SeedVR2 · image', badge: 'BEST', description: 'Restores detail, true to the original', to: '/image/upscale?engine=best', mark: 'S' },
    { id: 'realesrgan', name: 'Real-ESRGAN ×4', badge: 'QUICK', description: 'Seconds per image, clean edges', to: '/image/upscale?engine=quick', mark: 'R' },
  ],
}

const ASSETS_MENU: MenuSection = {
  title: 'Assets',
  features: [
    { id: 'characters', title: 'Characters', description: 'Cast from your projects', to: '/assets#characters', icon: Users },
    { id: 'locations', title: 'Locations', description: 'Places from your projects', to: '/assets#locations', icon: MapPin },
    { id: 'uploads', title: 'Uploads', description: 'Images and videos you brought in', to: '/assets#uploads', icon: FolderUp },
    { id: 'loras', title: 'LoRAs', description: 'Custom styles and faces · later', to: '/assets#loras', icon: Boxes, disabled: true },
  ],
  models: [],
  modelsNote: 'Reusable characters and LoRAs across projects arrive in a later milestone.',
}

export const RAIL_ITEMS: RailItem[] = [
  { id: 'home', label: 'Home', icon: Home, to: '/' },
  { id: 'assets', label: 'Assets', icon: UserRound, to: '/assets', menu: ASSETS_MENU },
  { id: 'brand', label: 'Brand Kits', icon: Stamp, to: '/brand-kits' },
  { id: 'image', label: 'Image', icon: ImageIcon, to: '/image/generate', menu: IMAGE_MENU },
  { id: 'video', label: 'Video', icon: Clapperboard, to: '/video/quick', menu: VIDEO_MENU },
  { id: 'upscale', label: 'Upscale', icon: ImageUpscale, to: '/image/upscale', menu: UPSCALE_MENU },
  { id: 'queue', label: 'Queue', icon: ListOrdered, to: '/queue' },
]

export const SETTINGS_ITEM: RailItem = { id: 'settings', label: 'Settings', icon: Settings, to: '/settings' }

const TOOL_ROUTE: Partial<Record<ModelType, string>> = { image: '/image/generate', edit: '/image/edit', video: '/video/create' }

const navModel = (m: ModelInfo): Model => ({
  id: m.id,
  name: m.label,
  badge: m.badge,
  description: m.description,
  to: `${TOOL_ROUTE[m.type]}?model=${encodeURIComponent(m.id)}`,
  mark: m.label.charAt(0).toUpperCase(),
})

// an engine the catalog doesn't mention stays listed (older server); one it marks unavailable goes
const engineListed = (m: Model, upscale: ModelInfo[]) => {
  const entry = upscale.find((u) => u.id === m.catalogId)
  return !entry || entry.available
}

export type Catalog = Record<ModelType, ModelInfo[]>
export type MenuId = 'image' | 'video' | 'upscale' | 'assets'

/** The Models columns, from the catalog: generation models first, then the upscale engines. Available only. */
export function menusFrom(catalog: Catalog): Record<MenuId, MenuSection> {
  const gen = (...types: ModelType[]) => types.flatMap((t) => catalog[t] ?? []).filter((m) => m.available).map(navModel)
  const engines = (section: MenuSection) => section.models.filter((m) => engineListed(m, catalog.upscale ?? []))
  return {
    image: { ...IMAGE_MENU, models: [...gen('image', 'edit'), ...engines(IMAGE_MENU)] },
    video: { ...VIDEO_MENU, models: [...gen('video'), ...engines(VIDEO_MENU)] },
    upscale: { ...UPSCALE_MENU, models: engines(UPSCALE_MENU) },
    assets: ASSETS_MENU,
  }
}

export const MENUS = menusFrom(FALLBACK_MODELS)

/** Which rail item lights up for a path. Upscale pages belong to Upscale, not Image/Video. */
export function activeRail(pathname: string): RailId | null {
  const p = pathname.replace(/\/+$/, '') || '/'
  if (p === '/') return 'home'
  if (/^\/(image|video)\/upscale/.test(p)) return 'upscale'
  if (p.startsWith('/image')) return 'image'
  if (p.startsWith('/video') || p.startsWith('/projects') || p === '/create' || p.startsWith('/quick')) return 'video'
  if (p.startsWith('/assets')) return 'assets'
  if (p.startsWith('/brand-kits')) return 'brand'
  if (p.startsWith('/queue')) return 'queue'
  if (p.startsWith('/settings')) return 'settings'
  return null
}

const TITLES: [RegExp, string][] = [
  [/^\/$/, 'Home'],
  [/^\/(video\/quick|create)$/, 'Quick video'],
  [/^\/quick\//, 'Quick video'],
  [/^\/(video\/)?projects$/, 'Studio projects'],
  [/^\/video\/create/, 'Create video'],
  [/^\/video\/templates/, 'Video templates'],
  [/^\/video\/upscale/, 'Video upscale'],
  [/^\/video\/library/, 'Video library'],
  [/^\/image\/generate/, 'Create image'],
  [/^\/image\/edit/, 'Edit image'],
  [/^\/image\/references/, 'References'],
  [/^\/image\/templates/, 'Image templates'],
  [/^\/image\/upscale/, 'Image upscale'],
  [/^\/image\/library/, 'Image library'],
  [/^\/assets/, 'Assets'],
  [/^\/brand-kits/, 'Brand kits'],
  [/^\/image\/img2img/, 'Image to image'],
  [/^\/video\/img2vid/, 'Image to video'],
  [/^\/queue/, 'Queue'],
  [/^\/settings/, 'Settings'],
]

export const pageTitle = (pathname: string) => TITLES.find(([re]) => re.test(pathname.replace(/(.)\/+$/, '$1')))?.[1] ?? 'Mix AI Cinema Studio'
