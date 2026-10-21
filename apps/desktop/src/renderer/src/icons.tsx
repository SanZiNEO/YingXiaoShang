import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement> & { size?: number }

function iconProps({ size = 16, ...props }: IconProps) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    ...props,
  }
}

export function BrandMark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M12 2.8l1.9 5.2L19.2 10l-5.3 2L12 17.2l-2-5.2L4.8 10l5.3-2L12 2.8z" fill="var(--accent)" opacity="0.9" />
      <path d="M18.2 15.2l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2z" fill="currentColor" opacity="0.45" />
    </svg>
  )
}

export function SendIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M4.5 12h14" />
      <path d="M13 6.5l5.5 5.5L13 17.5" />
    </svg>
  )
}

export function PlusIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

export function CloseIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
    </svg>
  )
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M7 10l5 5 5-5" />
    </svg>
  )
}

export function ChevronRightIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M10 7l5 5-5 5" />
    </svg>
  )
}

export function DocIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M7 3.8h6.5L18 8.3v11.9H7z" />
      <path d="M13.5 3.8v4.5H18" />
      <path d="M9.5 12h6M9.5 15.5h4" />
    </svg>
  )
}

export function QuestionIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <rect x="4" y="4" width="16" height="16" rx="4" />
      <path d="M9.6 9.3a2.5 2.5 0 114 2c-.9.7-1.6 1.2-1.6 2.3" />
      <path d="M12 16.7h.01" />
    </svg>
  )
}

export function ResearchIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <circle cx="10.8" cy="10.8" r="5.8" />
      <path d="M15.2 15.2L20 20" />
      <path d="M8.5 10.8h4.6M10.8 8.5v4.6" />
    </svg>
  )
}

export function BpIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M5 4.5h14v15H5z" />
      <path d="M8.5 8.5h7M8.5 12h7M8.5 15.5h4" />
    </svg>
  )
}

export function NewsIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M5 5.5h11.5v13H5z" />
      <path d="M16.5 8.5H19v10H8" />
      <path d="M8 9h5.5M8 12h5.5M8 15h3.5" />
    </svg>
  )
}

export function GrowthIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M5 18.5V6.5M5 18.5h14" />
      <path d="M8 15l3-3.5 2.5 2 3.5-5" />
      <path d="M17 8.5h-2.5M17 8.5v2.5" />
    </svg>
  )
}

export function EvidenceIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M6 4.5h9l3 3v12H6z" />
      <path d="M9 9h6M9 12.5h6M9 16h3.5" />
      <path d="M15 4.5v3h3" />
    </svg>
  )
}

export function ProcessIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <circle cx="6.5" cy="7" r="1.6" />
      <circle cx="6.5" cy="17" r="1.6" />
      <path d="M10 7h8M10 17h8" />
      <path d="M6.5 8.6v6.8" />
    </svg>
  )
}

export function FolderIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M4 7.5h6l2 2h8v9.5H4z" />
      <path d="M4 7.5V5.5h6l2 2" />
    </svg>
  )
}

export function DownloadIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M12 4.5v10" />
      <path d="M8 11l4 4 4-4" />
      <path d="M5 19.5h14" />
    </svg>
  )
}

export function ExpandIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M9 4.5H4.5V9M15 4.5h4.5V9M9 19.5H4.5V15M15 19.5h4.5V15" />
    </svg>
  )
}

export function QuoteIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M7 8.5H4.5V15H9V11c0-1.5-1-2.5-2-2.5z" />
      <path d="M16 8.5h-2.5V15H18v-4c0-1.5-1-2.5-2-2.5z" />
    </svg>
  )
}

export function CheckIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M5 12.5l4.2 4L19 6.8" />
    </svg>
  )
}

export function ClockIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <circle cx="12" cy="12" r="7.5" />
      <path d="M12 8v4.5l2.8 1.6" />
    </svg>
  )
}

export function SparkIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M12 3.5l1.6 4.4 4.4 1.6-4.4 1.6L12 15.5l-1.6-4.4L6 9.5l4.4-1.6L12 3.5z" />
      <path d="M18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7.7-1.8z" />
    </svg>
  )
}

export function LayersIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M12 4l8 4-8 4-8-4 8-4z" />
      <path d="M4 12l8 4 8-4" />
      <path d="M4 16l8 4 8-4" />
    </svg>
  )
}

export function LedgerIcon(props: IconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M5 4.5h14v15H5z" />
      <path d="M8 8h8M8 11.5h8M8 15h5" />
      <path d="M5 7.5h14" />
    </svg>
  )
}

export function ArtifactIcon({ type, size = 15 }: { type: string; size?: number }) {
  if (type === 'question_set') return <QuestionIcon size={size} />
  if (type === 'research_design') return <ResearchIcon size={size} />
  if (type === 'bp_outline') return <BpIcon size={size} />
  if (type === 'case_analysis') return <NewsIcon size={size} />
  if (type === 'case_study') return <SparkIcon size={size} />
  if (type === 'growth_card') return <GrowthIcon size={size} />
  return <DocIcon size={size} />
}

export function EmptyChatArt({ width = 220 }: { width?: number }) {
  return (
    <svg width={width} height={Math.round(width * 0.58)} viewBox="0 0 220 128" fill="none" aria-hidden>
      <path d="M28 96c18-6 24-22 20-34-5-15 6-30 24-33 11-2 18 2 24 7 8-9 22-11 33-4 12 8 14 22 7 33 11 2 18 12 16 23-2 12-13 19-25 16-6 10-20 13-30 6-9 12-27 12-35-1-10 5-23 1-28-7-4-6-4-10-6-16z" fill="var(--surface)" stroke="var(--border)" strokeWidth="1.4" />
      <path d="M72 62c8-10 22-12 32-5 7 5 9 14 6 22" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" opacity="0.85" />
      <circle cx="88" cy="52" r="3.2" fill="var(--accent)" opacity="0.8" />
      <circle cx="126" cy="46" r="2.2" fill="var(--accent)" opacity="0.35" />
      <circle cx="146" cy="76" r="2.6" fill="var(--accent)" opacity="0.25" />
      <path d="M56 74h14M63 67v14" stroke="var(--accent)" strokeWidth="1.8" strokeLinecap="round" opacity="0.4" />
      <path d="M154 92l3-7 7-3-7-3-3-7-3 7-7 3 7 3 3 7z" fill="var(--accent)" opacity="0.18" />
      <path d="M170 28l2.2-5 5-2.2-5-2.2-2.2-5-2.2 5-5 2.2 5 2.2 2.2 5z" fill="var(--accent)" opacity="0.3" />
    </svg>
  )
}
