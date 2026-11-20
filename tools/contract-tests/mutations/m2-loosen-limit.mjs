/**
 * M2 · 放开 limit 整数 / 上下限校验（声明式变异规格）
 *
 * 对应 02-contract §10 / 04-acceptance §5 M2：
 *   落点 apps/server/src/rpc/validate.ts（或对应 limit 校验 handler）；
 *   去掉 limit 类型与上下限校验，越界值放行；
 *   应变红用例 E-034（news.list 传 limit=99999，期望 400 BAD_REQUEST + 逐字消息）。
 *
 * 锚点策略（A 轮文件尚未落地，不能写死静态 .patch）：
 *   首选冻结 §3 的逐字错误消息字面量，候选依次为守卫表达式；运行时只接受「全文唯一命中」
 *   的候选。注意 artifacts.list 与 news.list 同为 1..200，消息字面量可能出现两次，
 *   不唯一就换下一个候选；全部不唯一或不存在则记 anchor-miss，不改文件。
 *
 * A 轮落盘后只读干跑实测（2026-11-20，详见 mutations/README.md §4）：
 *   validate.ts 是通用数字校验器，limit 专属消息不在本文件；news.list 的
 *   `limit 必须是 1 到 200 的整数。` 字面量落在 handlers/content.ts:57。
 *   本文件内唯一可中和的守卫是 L38 整数判定与 L39 上下限判定，已作为兜底候选；
 *   中和任一通用守卫会同时放开所有数字参数的对应校验，仍足以让 E-034 的 99999 放行。
 */

export default {
  id: 'M2',
  title: '放开 limit 整数与上下限校验',
  file: 'apps/server/src/rpc/validate.ts',
  targetCase: 'E-034',
  targetCommand: 'node run.mjs --target http --only E-034',
  redExpectation:
    'E-034 期望 400 BAD_REQUEST + 逐字消息「limit 必须是 1 到 200 的整数。」；校验放开后越界 limit=99999 被放行（实际 200），httpStatus 与 errorCode 断言变红。',
  notRunWhenMissing: true,
  edits: [
    {
      anchor: 'limit 必须是 1 到 200 的整数。',
      anchorAlternatives: [
        'limit < 1 || limit > 200',
        'limit > 200 || limit < 1',
        'Number.isInteger(limit)',
        'if (value < options.min || value > options.max) fail(options.message, key)',
        'if (!Number.isInteger(value)) fail(INTEGER_MESSAGE(key), key)',
      ],
      replace:
        '// [M2 mutation] limit 整数 / 上下限校验分支已在回放窗口内临时放开；revert 后由原字节逐字节还原。',
      description:
        '锚点取 limit 校验分支：首选冻结 §3 逐字消息「limit 必须是 1 到 200 的整数。」；候选依次为上下限守卫表达式与整数类型守卫；' +
        '兜底两条是 A 轮通用校验器 validate.ts 内的真实守卫（上下限判定、整数判定），整句替换为注释即禁用该分支。' +
        '替换为注释等于让该分支不再拒绝越界值。消息字面量在 news.list / artifacts.list 两处可能重复，重复即不唯一，按候选顺序下移；候选 0 次或多次命中均判 anchor-miss，不改文件。',
    },
  ],
}
