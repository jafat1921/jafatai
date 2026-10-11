// Aerab / tashkeel for the Arabic-script languages (contract v23)
export const ARABIC_SCRIPT_LANGS = ['ur', 'ar', 'fa', 'ps', 'sd', 'pnb'] as const

const ARABIC_LETTER = /[ء-يٮ-ۓەۮ-ۿݐ-ݿࢠ-ࣉ]/

/** True when the text has Arabic-script letters (Urdu, Arabic, Persian, Pashto, Sindhi, Shahmukhi). */
export const hasArabicScript = (text: string | null | undefined) => ARABIC_LETTER.test(text ?? '')

/** ur, ar-EG, pnb, pa-Arab... but never Roman Urdu. */
export function isArabicScriptLang(code: string | null | undefined) {
  const c = (code ?? '').toLowerCase()
  if (!c || c.includes('latn')) return false
  if (c === 'pa-arab') return true
  return (ARABIC_SCRIPT_LANGS as readonly string[]).includes(c.split('-')[0])
}

/** What the marks are called in that language: Arabic speakers say tashkeel. */
export const aerabTerm = (code?: string | null) => ((code ?? '').toLowerCase().startsWith('ar') ? 'tashkeel' : 'aerab')

const lines = (n: number) => `${n} line${n === 1 ? '' : 's'}`

/** "Aerab added to 12 lines" plus the lines the check left alone, for the live region. */
export function aerabNote(marked: number, kept: number, lowCoverage = 0) {
  const head = marked ? `Aerab added to ${lines(marked)}.` : 'No lines needed aerab.'
  const parts = [head]
  if (kept) parts.push(`${lines(kept)} kept as written: the marking changed their words, so they were left alone.`)
  if (lowCoverage) parts.push(`${lines(lowCoverage)} still lightly marked; check ${lowCoverage === 1 ? 'it' : 'them'} before voicing.`)
  return parts.join(' ')
}

const flat = (t: string) => t.replace(/\s*\n\s*/g, ' ')

/** Several texts as one request body: the server marks line by line, so each becomes one line. */
export const joinLines = (texts: string[]) => texts.map(flat).join('\n')

/** The marked body split back over `texts`; a text the marking didn't touch keeps its own line breaks. */
export function splitLines(texts: string[], marked: string): string[] | null {
  const out = marked.split('\n')
  if (out.length !== texts.length) return null
  return out.map((t, i) => (t === flat(texts[i]) ? texts[i] : t))
}
