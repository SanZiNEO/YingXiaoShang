import { useLayoutEffect, useState } from 'react'
import type { RefObject } from 'react'

/**
 * 观察根元素的真实宽度（不是 window），rAF 节流。
 * 首帧直接读 getBoundingClientRect，避免先按 0 宽算一版布局。
 */
export function useViewportWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0)

  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return

    setWidth(node.getBoundingClientRect().width)

    let frame = 0
    const measure = () => {
      frame = 0
      const next = node.getBoundingClientRect().width
      setWidth((current) => (Math.abs(current - next) < 0.5 ? current : next))
    }
    const observer = new ResizeObserver(() => {
      if (frame !== 0) return
      frame = window.requestAnimationFrame(measure)
    })
    observer.observe(node)

    return () => {
      observer.disconnect()
      if (frame !== 0) window.cancelAnimationFrame(frame)
    }
  }, [ref])

  return width
}
