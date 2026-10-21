export const CHAPTER_TITLES: Record<number, string> = {
  1: '市场营销导论',
  2: '市场营销管理哲学',
  3: '市场营销环境',
  4: '消费者市场与购买行为分析',
  5: '组织市场与购买行为分析',
  6: '市场营销调研',
  7: '目标市场营销战略',
  8: '产品策略',
  9: '价格策略',
  10: '渠道策略',
  11: '促销策略',
  12: '市场营销计划、组织与控制',
  13: '市场营销新发展',
}

export function chapterId(number: number): string {
  return `ch${String(number).padStart(2, '0')}`
}

export function chapterNumberFromPath(path: string): number | undefined {
  const match = /第\s*(\d+)\s*章/.exec(path)
  return match ? Number(match[1]) : undefined
}
