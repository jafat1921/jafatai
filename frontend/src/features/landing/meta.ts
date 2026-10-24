import type { PageMeta } from './head'

// kept apart from the pages so the tests can check every title and description in one place

export const HOME_FAQ: [string, string][] = [
  ['What can I make with Jafat?', 'Pictures, social media ads, films, presenter videos, Urdu poetry videos, dubbing, podcasts, voices, music, restored photos and 3D models.'],
  ['Which languages can I work in?', 'English and Urdu. Urdu is set in Nastaliq with full aerab, right to left, and its voices read as a native speaker would.'],
  ['Who owns what I make?', 'You do. It stays in your private library until you decide to share it.'],
  ['What do I need?', 'Only a web browser, on a computer or a phone. There is nothing to install.'],
  ['Does an account cost anything?', 'No. A free account lets you try the studio, and paid plans add more room when you need it.'],
]

export const PLANS_FAQ: [string, string][] = [
  ['Is there a free plan?', 'Yes. A free account lets you try the studio before you choose anything else.'],
  ['What do paid plans add?', 'More room, more studios and private work. Each plan lists exactly what it includes.'],
  ['How do I pay?', 'Prices are in Pakistani rupees, and you can pay with local payment methods.'],
  ['Do you have plans for teams?', 'Yes. Ask us about plans for teams, agencies and studios.'],
]

export const HOME_META: PageMeta = {
  title: 'Jafat AI Studio: AI video, pictures and voices in Urdu',
  description:
    'Make AI videos, Urdu poetry shorts, social ads, voice-overs and music in Urdu and English. Jafat AI Studio is private by default. Start free today.',
  path: '/',
  faq: HOME_FAQ,
}

export const STUDIO_META: PageMeta = {
  title: 'AI ads, Urdu poetry videos and dubbing | Jafat AI Studio',
  description:
    'AI ads for Instagram, TikTok and WhatsApp, Urdu poetry videos, dubbing, Urdu text to speech, podcasts, music and old photo restoration, all in one studio.',
  path: '/studio',
}

export const PLANS_META: PageMeta = {
  title: 'Plans and pricing: start free | Jafat AI Studio',
  description:
    'Jafat AI Studio plans and prices: start free, then move up for more room, more studios and private work. Prices in Pakistani rupees, paid locally.',
  path: '/plans',
  faq: PLANS_FAQ,
}

export const ABOUT_META: PageMeta = {
  title: 'About Jafat: a creative AI studio for Urdu and English',
  description:
    'Jafat is an Urdu-first creative AI studio for storytellers, in Urdu and English. Private by default, so your poems, films and ads stay yours.',
  path: '/about',
}

export const PUBLIC_META = [HOME_META, STUDIO_META, PLANS_META, ABOUT_META]
