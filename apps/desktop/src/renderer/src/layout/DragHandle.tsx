import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'

export interface DragHandleProps {
  side: 'sidebar' | 'workspace'
  /** 手柄左边缘相对根容器的 px 位置。 */
  left: number
  onStart(): void
  onDrag(dx: number): void
  onEnd(): void
  onReset(): void
}

const KEYBOARD_STEP = 16

const handleStyle: CSSProperties = {
  position: 'absolute',
  top: 0,
  bottom: 0,
  width: 8,
  marginLeft: -4,
  cursor: 'col-resize',
  touchAction: 'none',
  zIndex: 6,
  background: 'transparent',
}

const TITLE: Record<DragHandleProps['side'], string> = {
  sidebar: '拖动调整侧栏宽度，双击复位',
  workspace: '拖动调整右栏宽度，双击复位',
}

export function DragHandle({ side, left, onStart, onDrag, onEnd, onReset }: DragHandleProps) {
  const [dragging, setDragging] = useState(false)
  const originRef = useRef(0)
  const latestRef = useRef(0)
  const frameRef = useRef(0)
  const activeRef = useRef(false)
  const callbacksRef = useRef({ onStart, onDrag, onEnd, onReset })
  callbacksRef.current = { onStart, onDrag, onEnd, onReset }

  useEffect(() => () => {
    activeRef.current = false
    if (frameRef.current !== 0) {
      window.cancelAnimationFrame(frameRef.current)
      frameRef.current = 0
    }
  }, [])

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    originRef.current = event.clientX
    latestRef.current = event.clientX
    activeRef.current = true
    setDragging(true)
    event.currentTarget.setPointerCapture(event.pointerId)
    callbacksRef.current.onStart()
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!activeRef.current) return
    latestRef.current = event.clientX
    if (frameRef.current !== 0) return
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = 0
      if (!activeRef.current) return
      callbacksRef.current.onDrag(latestRef.current - originRef.current)
    })
  }

  const finish = (event?: ReactPointerEvent<HTMLDivElement>) => {
    if (!activeRef.current) return
    if (event) latestRef.current = event.clientX
    if (frameRef.current !== 0) {
      window.cancelAnimationFrame(frameRef.current)
      frameRef.current = 0
    }
    activeRef.current = false
    setDragging(false)
    callbacksRef.current.onDrag(latestRef.current - originRef.current)
    callbacksRef.current.onEnd()
    if (event && event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    callbacksRef.current.onStart()
    callbacksRef.current.onDrag(event.key === 'ArrowLeft' ? -KEYBOARD_STEP : KEYBOARD_STEP)
    callbacksRef.current.onEnd()
  }

  return (
    <div
      className="resize-handle"
      data-side={side}
      data-dragging={dragging ? 'true' : undefined}
      role="separator"
      aria-orientation="vertical"
      aria-label="拖动调整宽度"
      title={TITLE[side]}
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      onLostPointerCapture={finish}
      onDoubleClick={() => callbacksRef.current.onReset()}
      onKeyDown={handleKeyDown}
      style={{ ...handleStyle, left }}
    />
  )
}
