import type { QueryClient } from '@tanstack/react-query'
import { qk } from '@/hooks/keys'
import type { ModelInfo, ModelType } from '@/lib/types'

const m = (x: Partial<ModelInfo> & Pick<ModelInfo, 'id' | 'type' | 'label'>): ModelInfo => ({
  badge: null,
  description: '',
  capabilities: [],
  available: true,
  default: false,
  ...x,
})

// shaped like contract-v6's table
export const CATALOG: Record<ModelType, ModelInfo[]> = {
  image: [
    m({ id: 'zimage_turbo', type: 'image', label: 'Z-Image Turbo', badge: 'FAST', description: 'Photoreal', capabilities: ['t2i'], est_seconds: 7, default: true }),
    m({
      id: 'qwen_image_2512',
      type: 'image',
      label: 'Qwen-Image 2512',
      badge: 'TEXT',
      description: 'Text & posters, incl. Urdu',
      capabilities: ['t2i', 'text_render'],
      est_seconds: 30,
      speeds: [
        { id: 'full', label: 'Full', steps: 24 },
        { id: 'lightning4', label: 'Lightning 4-step', steps: 4 },
        { id: 'turbo2', label: 'Turbo 2-step', steps: 2, note: 'roughest' },
      ],
      default_speed: 'full',
    }),
    m({ id: 'flux2_klein', type: 'image', label: 'FLUX.2 klein 4B', badge: 'FAST', description: 'Fastest', capabilities: ['t2i'], available: false, reason: 'Missing flux-2-klein-4b-fp8' }),
  ],
  edit: [
    m({ id: 'qwen_image_edit_2511', type: 'edit', label: 'Qwen-Image-Edit 2511', badge: 'BEST', capabilities: ['edit', 'refs', 'multi_angle'], max_refs: 3, default: true }),
    m({ id: 'flux2_klein_edit', type: 'edit', label: 'FLUX.2 klein 4B (base)', capabilities: ['edit', 'refs'], max_refs: 1 }),
  ],
  video: [
    m({
      id: 'ltx23_distilled',
      type: 'video',
      label: 'LTX-2.3',
      capabilities: ['t2v', 'i2v', 'flf', 'audio', 'longtake'],
      max_duration_s: 300,
      default: true,
      smooth_motion: { available: true },
    }),
    m({ id: 'ltx23_hq', type: 'video', label: 'LTX-2.3 High quality', badge: 'HQ', capabilities: ['t2v', 'i2v', 'flf', 'audio'], max_duration_s: 10, smooth_motion: { available: true } }),
    m({ id: 'wan22_t2v', type: 'video', label: 'Wan 2.2 14B', description: 'No sound, text only', capabilities: ['t2v'], max_duration_s: 5 }),
  ],
  upscale: [
    m({ id: 'seedvr2', type: 'upscale', label: 'SeedVR2', default: true }),
    m({ id: 'flashvsr', type: 'upscale', label: 'FlashVSR', available: false, reason: 'Missing node' }),
    m({ id: 'esrgan', type: 'upscale', label: 'Real-ESRGAN' }),
    m({ id: 'zimage_redraw', type: 'upscale', label: 'Z-Image redraw' }),
  ],
}

export function seedCatalog(qc: QueryClient, catalog = CATALOG) {
  for (const [type, list] of Object.entries(catalog)) qc.setQueryData(qk.models(type as ModelType), list)
}
