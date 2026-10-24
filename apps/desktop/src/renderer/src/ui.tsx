import type { ReactNode } from 'react'

export const COLORS = {
  text: 'var(--fg)',
  muted: 'var(--muted)',
  border: 'var(--border)',
  surface: 'var(--surface)',
  accent: 'var(--accent)',
  success: 'var(--success)',
  warning: 'var(--warning)',
  error: 'var(--error)',
}

export function Page({ title, subtitle, actions, children }: {
  title: string
  subtitle?: string
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <div style={{ padding: '24px 28px 40px', color: COLORS.text, maxWidth: 1120, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <h1 style={{ fontSize: 22, lineHeight: 1.3, margin: 0 }}>{title}</h1>
          {subtitle ? <p style={{ color: COLORS.muted, margin: '6px 0 0', fontSize: 13 }}>{subtitle}</p> : null}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{actions}</div>
      </div>
      <div style={{ marginTop: 20 }}>{children}</div>
    </div>
  )
}

export function Card({ title, children, actions }: { title?: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section
      style={{
        background: COLORS.surface,
        border: `1px solid ${COLORS.border}`,
        borderRadius: 12,
        padding: 16,
      }}
    >
      {title || actions ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 10 }}>
          {title ? <h2 style={{ fontSize: 14, margin: 0, fontWeight: 600 }}>{title}</h2> : <span />}
          <div style={{ display: 'flex', gap: 6 }}>{actions}</div>
        </div>
      ) : null}
      {children}
    </section>
  )
}

export function Button({ children, onClick, kind = 'default', disabled, title }: {
  children: ReactNode
  onClick?: () => void
  kind?: 'default' | 'primary' | 'ghost'
  disabled?: boolean
  title?: string
}) {
  const palette = kind === 'primary'
    ? { background: COLORS.accent, color: 'var(--on-accent, #fff)', border: '1px solid transparent' }
    : kind === 'ghost'
      ? { background: 'transparent', color: COLORS.muted, border: '1px solid transparent' }
      : { background: 'transparent', color: COLORS.text, border: `1px solid ${COLORS.border}` }
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      style={{
        ...palette,
        borderRadius: 8,
        padding: '6px 12px',
        fontSize: 13,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {children}
    </button>
  )
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 12, color: COLORS.muted }}>
      <span>{label}</span>
      {children}
    </label>
  )
}

const inputStyle = {
  background: 'transparent',
  color: COLORS.text,
  border: `1px solid ${COLORS.border}`,
  borderRadius: 8,
  padding: '7px 9px',
  fontSize: 13,
  width: '100%',
  boxSizing: 'border-box' as const,
}

export function TextInput({ value, onChange, placeholder, type = 'text' }: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  type?: string
}) {
  return (
    <input
      type={type}
      value={value}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
      style={inputStyle}
    />
  )
}

export function TextArea({ value, onChange, placeholder, rows = 4 }: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  rows?: number
}) {
  return (
    <textarea
      value={value}
      rows={rows}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
      style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }}
    />
  )
}

export function Select({ value, onChange, options }: {
  value: string
  onChange: (value: string) => void
  options: Array<{ value: string; label: string }>
}) {
  return (
    <select value={value} onChange={(event) => onChange(event.target.value)} style={inputStyle}>
      {options.map((option) => (
        <option key={option.value} value={option.value}>{option.label}</option>
      ))}
    </select>
  )
}

export function Tag({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'accent' | 'success' | 'warning' }) {
  const color = tone === 'accent' ? COLORS.accent : tone === 'success' ? COLORS.success : tone === 'warning' ? COLORS.warning : COLORS.muted
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        border: `1px solid ${color}`,
        color,
        borderRadius: 999,
        padding: '1px 8px',
        fontSize: 11,
        lineHeight: 1.7,
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div style={{ color: COLORS.muted, fontSize: 13, padding: '24px 0', textAlign: 'center' }}>{children}</div>
  )
}

/**
 * 模型写的页面只跑在沙箱里：禁脚本、禁同源、禁外链，只留内联样式。
 * 页面内容进不了主界面，也就碰不到宿主数据。
 */
const HTML_CSP = ["default-src 'none'", "style-src 'unsafe-inline'", 'img-src data:', 'font-src data:'].join('; ')

export function HtmlFrame({ html, title }: { html: string; title: string }) {
  const doc = [
    '<!DOCTYPE html><html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${HTML_CSP}">`,
    '<style>',
    'html,body{margin:0;padding:16px;background:#fff;color:#1f2328;',
    'font:15px/1.8 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,"PingFang SC","Microsoft YaHei",sans-serif;',
    '-webkit-text-size-adjust:100%;overflow-wrap:break-word}',
    'img,video,table{max-width:100%}',
    '</style></head><body>',
    html,
    '</body></html>',
  ].join('')
  return (
    <iframe
      title={title}
      sandbox=""
      referrerPolicy="no-referrer"
      srcDoc={doc}
      style={{ width: '100%', height: '100%', minHeight: 420, border: 'none', background: '#fff', borderRadius: 8 }}
    />
  )
}

export function ErrorText({ children }: { children: ReactNode }) {
  return <div style={{ color: COLORS.error, fontSize: 12, marginTop: 8 }}>{children}</div>
}

export function Row({ children, onClick, active }: { children: ReactNode; onClick?: () => void; active?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        background: active ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : 'transparent',
        border: 'none',
        borderLeft: `2px solid ${active ? COLORS.accent : 'transparent'}`,
        color: COLORS.text,
        padding: '8px 10px',
        fontSize: 13,
        cursor: 'pointer',
        borderRadius: 6,
      }}
    >
      {children}
    </button>
  )
}
