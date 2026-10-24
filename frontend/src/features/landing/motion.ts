import { useEffect, useRef, useState, type RefObject } from 'react'

// Motion on the public site is opt-in from JS: without it (or with reduced motion asked for) every
// section is simply there, fully drawn. The CSS hides nothing unless .jafat carries the "motion" class.

export function motionAllowed() {
  if (typeof window === 'undefined' || typeof IntersectionObserver === 'undefined') return false
  return !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

/**
 * Turns motion on for one marketing page: [data-reveal] blocks unfurl once as they scroll in,
 * [data-live] blocks only run their loops while on screen, and everything rests in a hidden tab.
 */
export function usePageMotion(root: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = root.current
    if (!el) return
    // the headline and page fade start from hidden and only show once their animation plays; a view whose
    // animation clock never moves (frozen embedded panes, some power-saving modes) would keep them hidden,
    // so a clock that hasn't run after 2.5 s switches every animation off and the page shows as it is
    const clock0 = Number(document.timeline?.currentTime ?? 0)
    const stall = window.setTimeout(() => {
      if (Number(document.timeline?.currentTime ?? 0) - clock0 < 500) el.classList.add('still')
    }, 2500)
    if (!motionAllowed()) return () => window.clearTimeout(stall)
    el.classList.add('motion')

    let heard = false
    const io = new IntersectionObserver(
      (entries) => {
        heard = true
        for (const e of entries) {
          const t = e.target as HTMLElement
          if (e.isIntersecting && t.hasAttribute('data-reveal')) t.classList.add('is-in')
          if (t.hasAttribute('data-live')) t.classList.toggle('is-live', e.isIntersecting)
          else if (e.isIntersecting) io.unobserve(t)
        }
      },
      { threshold: 0.12, rootMargin: '0px 0px -6% 0px' },
    )
    // pricing and other late arrivals mount after this runs, so watch for them too
    const watch = () => el.querySelectorAll('[data-reveal]:not(.is-in), [data-live]').forEach((n) => io.observe(n))
    watch()
    const mo = new MutationObserver((records) => {
      if (records.some((r) => [...r.addedNodes].some((n) => n.nodeType === 1))) watch()
    })
    mo.observe(el, { childList: true, subtree: true })

    // some embedded or pre-rendered views never run observer callbacks; rather than leave blocks
    // hidden there, drop the motion and show the page as it is
    const failsafe = window.setTimeout(() => {
      if (!heard) el.classList.remove('motion')
    }, 2500)

    const rest = () => el.classList.toggle('paused', document.hidden)
    document.addEventListener('visibilitychange', rest)

    const header = el.querySelector('.site-header')
    const onScroll = () => header?.classList.toggle('scrolled', window.scrollY > 8)
    window.addEventListener('scroll', onScroll, { passive: true })
    onScroll()

    return () => {
      window.clearTimeout(stall)
      window.clearTimeout(failsafe)
      io.disconnect()
      mo.disconnect()
      document.removeEventListener('visibilitychange', rest)
      window.removeEventListener('scroll', onScroll)
      el.classList.remove('motion', 'paused', 'still')
    }
  }, [root])
}

/** The hero collage leans toward the pointer and drifts a little against the scroll. */
export function useTilt(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current
    if (!el || !motionAllowed()) return
    let frame = 0
    let tx = 0
    let ty = 0
    const paint = () => {
      frame = 0
      el.style.setProperty('--tx', tx.toFixed(3))
      el.style.setProperty('--ty', ty.toFixed(3))
      el.style.setProperty('--sy', Math.min(window.scrollY, 600).toFixed(0))
    }
    const queue = () => {
      if (!frame) frame = requestAnimationFrame(paint)
    }
    const fine = window.matchMedia?.('(pointer: fine)').matches
    const onMove = (e: PointerEvent) => {
      tx = (e.clientX / window.innerWidth) * 2 - 1
      ty = (e.clientY / window.innerHeight) * 2 - 1
      queue()
    }
    if (fine) window.addEventListener('pointermove', onMove, { passive: true })
    window.addEventListener('scroll', queue, { passive: true })
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('scroll', queue)
    }
  }, [ref])
}

/** Types the prompt out once it is on screen. Starts (and, without motion, stays) as the full text. */
export function useTyping(ref: RefObject<HTMLElement | null>, text: string) {
  const [shown, setShown] = useState(text)
  const [typing, setTyping] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el || !motionAllowed()) return
    let timer = 0
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return
      io.disconnect()
      let n = 0
      setShown('')
      setTyping(true)
      timer = window.setInterval(() => {
        n += 1
        setShown(text.slice(0, n))
        if (n >= text.length) {
          window.clearInterval(timer)
          setTyping(false)
        }
      }, 55)
    })
    io.observe(el)
    return () => {
      io.disconnect()
      window.clearInterval(timer)
    }
  }, [ref, text])
  return { shown, typing }
}

/**
 * Lets a scrolling row drift on its own, back and forth. Any pointer over it or focus inside it stops
 * the drift, so it never moves under someone reading or tabbing through it.
 */
export function useDrift(ref: RefObject<HTMLElement | null>) {
  const held = useRef(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (!motionAllowed()) {
      el.dataset.drift = 'off'
      return
    }
    let dir = 1
    let frame = 0
    let carry = 0
    const set = (v: boolean) => {
      held.current = v
      el.dataset.drift = v ? 'paused' : 'running'
    }
    const tick = () => {
      frame = requestAnimationFrame(tick)
      if (held.current || document.hidden || !el.closest('.is-live')) return
      const max = el.scrollWidth - el.clientWidth
      if (max <= 0) return
      carry += 0.35 * dir
      const step = Math.trunc(carry)
      if (!step) return
      carry -= step
      el.scrollLeft += step
      if (el.scrollLeft >= max - 1) dir = -1
      else if (el.scrollLeft <= 0) dir = 1
    }
    const on = () => set(true)
    const off = () => set(false)
    const blur = (e: FocusEvent) => {
      if (!el.contains(e.relatedTarget as Node | null)) set(false)
    }
    el.addEventListener('pointerenter', on)
    el.addEventListener('pointerleave', off)
    el.addEventListener('focusin', on)
    el.addEventListener('focusout', blur)
    el.addEventListener('touchstart', on, { passive: true })
    set(false)
    frame = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(frame)
      el.removeEventListener('pointerenter', on)
      el.removeEventListener('pointerleave', off)
      el.removeEventListener('focusin', on)
      el.removeEventListener('focusout', blur)
      el.removeEventListener('touchstart', on)
    }
  }, [ref])
}
