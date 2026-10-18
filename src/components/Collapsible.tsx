import { useEffect, useId, useState, type ReactNode } from 'react'

export interface CollapsibleProps {
  /** 面板标题 */
  title: string
  /** 标题右侧的简短状态徽标（如数量） */
  badge?: ReactNode
  /** 标题右侧的操作按钮区（不触发折叠） */
  actions?: ReactNode
  /** 默认是否展开 */
  defaultOpen?: boolean
  /** 受控展开状态（提供时组件变为受控） */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** 展开后是否限制最大高度并内部滚动，避免长列表把侧栏撑爆 */
  scrollable?: boolean
  children: ReactNode
}

/**
 * 可折叠面板：侧栏内容块统一用它包裹，实现渐进式披露，
 * 避免展开过多区块把左侧导航挤得过长。
 *
 * 无障碍：标题按钮带 aria-expanded / aria-controls，支持键盘操作与可见焦点。
 */
export default function Collapsible({
  title,
  badge,
  actions,
  defaultOpen = true,
  open: controlledOpen,
  onOpenChange,
  scrollable = false,
  children,
}: CollapsibleProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen)
  const isControlled = controlledOpen !== undefined
  const open = isControlled ? controlledOpen : uncontrolledOpen
  const bodyId = useId()

  const setOpen = (next: boolean) => {
    if (!isControlled) setUncontrolledOpen(next)
    onOpenChange?.(next)
  }

  return (
    <section className={`panel${open ? ' panel--open' : ''}`}>
      <div className="panel__head">
        <button
          type="button"
          className="panel__toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen(!open)}
        >
          <span className="panel__chevron" aria-hidden="true">
            <svg viewBox="0 0 16 16" width="12" height="12" focusable="false">
              <path
                d="M6 3.5 10.5 8 6 12.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <span className="panel__title">{title}</span>
        </button>
        {badge != null && <span className="panel__badge">{badge}</span>}
        {actions && (
          <div className="panel__actions" onClick={(e) => e.stopPropagation()}>
            {actions}
          </div>
        )}
      </div>
      {open && (
        <div className={`panel__body${scrollable ? ' panel__body--scroll' : ''}`} id={bodyId}>
          {children}
        </div>
      )}
    </section>
  )
}

/** 展开状态持久化：记住用户上一次折叠/展开的选择（同一 key 跨会话保留）。 */
export function usePersistentOpen(key: string, fallback = true) {
  const storageKey = `pcb-exploder:panel:${key}`
  const [open, setOpen] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem(storageKey)
      return v === null ? fallback : v === '1'
    } catch {
      return fallback
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, open ? '1' : '0')
    } catch {
      /* 隐私模式等场景忽略 */
    }
  }, [storageKey, open])
  return { open, setOpen }
}
