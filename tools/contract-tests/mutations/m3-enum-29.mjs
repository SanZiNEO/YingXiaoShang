/**
 * M3 · method 枚举删一项，30 → 29（声明式变异规格）
 *
 * 对应 02-contract §10 / 04-acceptance §5 M3：
 *   落点 docs/contracts/openapi.yaml（/api/v1/rpc 请求体 method 枚举）；
 *   枚举删除 1 项；应变红用例 E-077（method-enum 集合相等核对）。
 *
 * 锚点策略（A 轮文件尚未落地，不能写死静态 .patch）：
 *   取 YAML 枚举列表里的某一项 `- <method>`；首选冻结 §5 第 4 项 news.list，
 *   候选为其余枚举项，按顺序第一个在文件里唯一定位的生效；0 次或多次命中记 anchor-miss。
 */

export default {
  id: 'M3',
  title: 'OpenAPI method 枚举删除 1 项（30 → 29）',
  file: 'docs/contracts/openapi.yaml',
  targetCase: 'E-077',
  targetCommand: 'node coverage.mjs',
  redExpectation:
    'E-077 method-enum 集合相等核对变红：枚举 30 → 29，missing 列出被删方法，ok=false，coverage 状态 red。',
  notRunWhenMissing: true,
  edits: [
    {
      anchor: '- news.list',
      anchorAlternatives: [
        '- kps.list',
        '- artifacts.list',
        '- agent.sessions',
      ],
      replace: '',
      description:
        '锚点取 method 枚举列表里的某一项（YAML 列表行 `- <method>`）：首选 `- news.list`（冻结 §5 第 4 项）；候选为其余枚举项，按顺序第一个唯一定位的生效。' +
        '替换为空串即删掉该项枚举行。方法名若在描述文本等处再次出现导致不唯一，换下一个候选；候选 0 次或多次命中判 anchor-miss，不改文件。',
    },
  ],
}
