import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useAuthConfig, useMe } from '@/hooks/useAuth'
import { qk } from '@/hooks/keys'
import { api, type SitePlan } from '@/lib/api'

const FONTS =
  'https://fonts.googleapis.com/css2?family=Aref+Ruqaa:wght@700&family=Cormorant+Garamond:wght@400;500;600&family=Gulzar&family=IM+Fell+English+SC&family=Sora:wght@500;600;800&display=swap'

export const SITE = 'https://jafat.ai'
export const QUILL = '/brand/feather.svg'

// until the server answers, assume the door is open; an old server reads as closed (see useAuthConfig)
export function useInviteOnly() {
  const config = useAuthConfig()
  return config.data ? config.data.signup !== 'open' : false
}

// where "start creating" leads: the studio for someone signed in, otherwise sign-up while the door is open
export function useCreateHref() {
  const me = useMe()
  const invite = useInviteOnly()
  return me.data ? '/' : invite ? '/login' : '/signup'
}

// only the public site and the sign-in pages need these faces, so they come and go with them
export function useBrandFonts() {
  useEffect(() => {
    const pre = Object.assign(document.createElement('link'), { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossOrigin: '' })
    const css = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: FONTS })
    document.head.append(pre, css)
    return () => {
      pre.remove()
      css.remove()
    }
  }, [])
}

// public, no session needed; the admin's Package designer decides what is listed
export function useSitePlans() {
  return useQuery<SitePlan[]>({ queryKey: qk.sitePlans, queryFn: api.site.plans, staleTime: 5 * 60_000, retry: 1 })
}

const PER: Record<SitePlan['period'], string> = { day: ' / day', week: ' / week', month: ' / month', year: ' / year', none: '' }

export function priceLabel({ price_pkr, period, days }: Pick<SitePlan, 'price_pkr' | 'period' | 'days'>) {
  // the plan's own name often says Free already; the price line matches the paid cards instead
  if (price_pkr <= 0) return 'Rs 0'
  const rs = `Rs ${price_pkr.toLocaleString('en-PK')}`
  if (period !== 'none') return rs + PER[period]
  return days ? `${rs} for ${days} day${days === 1 ? '' : 's'}` : `${rs}, one-off`
}

export interface PageMeta {
  title: string
  description: string
  path: string
  faq?: [string, string][]
}

const ORG = {
  '@type': 'Organization',
  '@id': `${SITE}/#org`,
  name: 'Jafat AI Studio',
  url: SITE,
  logo: `${SITE}/brand/jafat-icon-512.png`,
}

const SITE_LD = { '@type': 'WebSite', '@id': `${SITE}/#site`, name: 'Jafat AI Studio', url: SITE, inLanguage: ['en', 'ur', 'ar'], publisher: { '@id': ORG['@id'] } }

const APP = {
  '@type': 'SoftwareApplication',
  name: 'Jafat AI Studio',
  url: SITE,
  applicationCategory: 'MultimediaApplication',
  operatingSystem: 'Web browser',
  inLanguage: ['en', 'ur', 'ar'],
  publisher: { '@id': ORG['@id'] },
  // no prices on the public side yet; the free plan is all we state
  offers: { '@type': 'Offer', name: 'Free', price: '0', priceCurrency: 'PKR' },
}

function upsert<T extends HTMLElement>(selector: string, make: () => T): { el: T; created: boolean } {
  const found = document.head.querySelector<T>(selector)
  if (found) return { el: found, created: false }
  const el = make()
  document.head.append(el)
  return { el, created: true }
}

const metaTag = (attr: 'name' | 'property', key: string) => () => {
  const m = document.createElement('meta')
  m.setAttribute(attr, key)
  return m
}

// title, description, share cards, canonical and JSON-LD for one public page; all put back on the way out
export function usePageMeta({ title, description, path, faq }: PageMeta) {
  useEffect(() => {
    const url = SITE + path
    const undo: (() => void)[] = []
    const was = document.title
    document.title = title
    undo.push(() => (document.title = was))

    const metas: ['name' | 'property', string, string][] = [
      ['name', 'description', description],
      ['property', 'og:title', title],
      ['property', 'og:description', description],
      ['property', 'og:url', url],
      ['name', 'twitter:title', title],
      ['name', 'twitter:description', description],
    ]
    for (const [attr, key, value] of metas) {
      const { el, created } = upsert(`meta[${attr}="${key}"]`, metaTag(attr, key))
      const old = el.getAttribute('content')
      el.setAttribute('content', value)
      undo.push(() => (created ? el.remove() : el.setAttribute('content', old ?? '')))
    }

    const canon = upsert<HTMLLinkElement>('link[rel="canonical"]', () => Object.assign(document.createElement('link'), { rel: 'canonical' }))
    const oldHref = canon.el.getAttribute('href')
    canon.el.setAttribute('href', url)
    undo.push(() => (canon.created ? canon.el.remove() : canon.el.setAttribute('href', oldHref ?? '')))

    const graph: object[] = [ORG, SITE_LD, APP, { '@type': 'WebPage', name: title, description, url, isPartOf: { '@id': SITE_LD['@id'] } }]
    if (faq?.length) {
      graph.push({
        '@type': 'FAQPage',
        mainEntity: faq.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })),
      })
    }
    const ld = Object.assign(document.createElement('script'), {
      type: 'application/ld+json',
      text: JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }),
    })
    ld.dataset.jafat = 'ld'
    document.head.append(ld)
    undo.push(() => ld.remove())

    return () => undo.reverse().forEach((f) => f())
  }, [title, description, path, faq])
}
