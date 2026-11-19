/**
 * TC → 实现侧 ID 的依赖台账（与 docs/11 的用例卡片一致）。
 * reporter 用它出总表，verify.ts 用它核对“每个 spec 至少引用 1 个实现侧 ID”。
 */
export const TC_DEPS: Record<string, string[]> = {
  'TC-P0-01': ['BOOT-01', 'CH-06', 'DATA-01', 'DATA-02', 'SVC-01', 'LEG-13'],
  'TC-P0-02': ['WIN-01', 'UI-01', 'CH-01', 'IPC-01', 'DATA-14a'],
  'TC-P0-03': ['FLOW-01', 'FLOW-02', 'CH-03', 'CH-09', 'EVT-01', 'EVT-03', 'SVC-21'],
  'TC-P0-04': ['IPC-27', 'IPC-28', 'DATA-04', 'SVC-20'],
  'TC-P0-05': ['UI-07', 'UI-08', 'UI-09', 'FLOW-08', 'IPC-19', 'IPC-20', 'DATA-13a', 'SVC-16'],
  'TC-P0-06': ['FLOW-03', 'UI-10', 'CH-05', 'IPC-13', 'SVC-21', 'LEG-08'],
  'TC-P0-07': ['BOOT-07', 'DATA-12b', 'DATA-12d', 'SVC-01'],
  'TC-P0-08': ['PKG-03', 'PKG-06', 'BOOT-01', 'DATA-06', 'LEG-22'],
  'TC-P0-09': ['PKG-03', 'PKG-04', 'DATA-06', 'DATA-07', 'DATA-12b'],
  'TC-P0-10': ['IPC-01', 'IPC-02', 'IPC-03', 'IPC-09', 'SVC-02', 'DATA-04', 'CH-01'],
  'TC-P0-11': ['EXT-06', 'IPC-08', 'IPC-09', 'SVC-18', 'BOOT-01'],
  'TC-P0-12': ['BOOT-05', 'WIN-02', 'DATA-11'],
  'TC-P0-13': ['IPC-21', 'SVC-16', 'DATA-13a', 'DATA-13b', 'IPC-20'],
  'TC-P1-01': ['CH-07', 'CH-08', 'DATA-10', 'UI-05', 'LEG-11'],
  'TC-P1-02': ['FLOW-04', 'UI-10', 'SVC-07', 'LEG-03', 'DATA-14b'],
  'TC-P1-03': ['FLOW-02', 'CH-02', 'EVT-01', 'LEG-01', 'LEG-02'],
  'TC-P1-04': ['IPC-08', 'IPC-09', 'IPC-11', 'SVC-18', 'EXT-10'],
  'TC-P1-05': ['IPC-10', 'EXT-06', 'EXT-10', 'SVC-19'],
  'TC-P1-06': ['EXT-07', 'SVC-19', 'EXT-12'],
  'TC-P1-07': ['FLOW-05', 'UI-11', 'UI-12', 'IPC-11', 'IPC-05', 'IPC-06'],
  'TC-P1-08': ['FLOW-06', 'IPC-27', 'IPC-34', 'SVC-20'],
  'TC-P1-09': ['FLOW-07', 'UI-04', 'IPC-14', 'IPC-16', 'IPC-17', 'IPC-18', 'SVC-14'],
  'TC-P1-10': ['FLOW-09', 'UI-14', 'UI-15', 'WIN-01'],
  'TC-P1-11': ['BOOT-02', 'BOOT-03', 'DATA-03', 'LEG-12'],
  'TC-P1-12': ['BOOT-04', 'WIN-01', 'LEG-18'],
  'TC-P1-13': ['UI-07', 'UI-08', 'FLOW-08', 'IPC-19', 'LEG-30'],
  'TC-P1-14': ['UI-13', 'IPC-36', 'IPC-37', 'SVC-27'],
  'TC-P1-15': ['IPC-22', 'IPC-25', 'IPC-26', 'SVC-14'],
  'TC-P1-16': ['IPC-31', 'IPC-32', 'IPC-33', 'SVC-20'],
  'TC-P1-17': ['PKG-05', 'DATA-07', 'LEG-13', 'BOOT-01'],
  'TC-P1-18': ['CH-01', 'CH-03', 'LEG-05', 'SVC-02'],
}

export const ALL_TCS = Object.keys(TC_DEPS)

export function depsOf(tc: string): string[] {
  return TC_DEPS[tc] ?? []
}
