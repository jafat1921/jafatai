import type { ImageOptions, ImageStyle } from '@/lib/types'

const style = (id: string, group: string, label: string, subtitle: string, best = 'zimage_turbo', preview = true): ImageStyle => ({
  id,
  group,
  label,
  subtitle,
  suffix: `${label.toLowerCase()} look`,
  negative: '',
  best_model: best,
  preview_url: preview ? `/api/images/styles/${id}/preview?v=1` : null,
})

// a slice of GET /images/options: enough groups and cards to page through with the keyboard
export const STYLE_OPTIONS: ImageOptions = {
  styles: [
    style('photoreal', 'photo', 'Photo', 'True to life'),
    style('cinematic', 'photo', 'Cinematic', 'Film still'),
    style('product', 'photo', 'Product', 'Studio packshot'),
    style('oil', 'painting', 'Oil Painting', 'Thick brushwork', 'qwen_image_2512'),
    style('watercolor', 'painting', 'Watercolour', 'Soft washes', 'qwen_image_2512', false),
    style('anime', 'anime', 'Anime', 'Cel shaded', 'qwen_image_2512'),
    style('clay', '3d', 'Claymation', 'Hand-made', 'flux2_klein'),
  ],
  style_groups: [
    { id: 'photo', label: 'Photo', restyle_strength: 0.3 },
    { id: 'painting', label: 'Painting', restyle_strength: 0.6 },
    { id: 'anime', label: 'Anime', restyle_strength: 0.6 },
    { id: '3d', label: '3D / Game', restyle_strength: 0.6 },
  ],
  style_aliases: { painterly: 'oil' },
}
