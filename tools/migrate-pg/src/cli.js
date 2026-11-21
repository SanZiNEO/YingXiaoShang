// @yxs/migrate-pg · cli.js
//
// 三个入口共用的参数与退出码工具。集中在这里的唯一理由是：三个入口的退出码语义必须
// 一致（02-contract §2.5：0 成功 / 1 用法 / 2 环境 / 3 校验不一致），而此前每个入口各自
// 手写解析循环，导致「未知参数静默忽略」这种缺陷在 migrate 与 rollback 里各犯一次。

// 带退出码的致命错误：由各入口顶层的 catch 统一打印并退出，不抛英文堆栈。
export class Fatal extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

export function exitUsage(message) {
  throw new Fatal(1, message)
}

export function exitEnv(message) {
  throw new Fatal(2, message)
}

// `--key=value` 与 `--key value` 两种写法都接受，返回 { name, inline }。
export function splitToken(token) {
  const eq = token.indexOf('=')
  if (eq === -1) return { name: token, inline: null }
  return { name: token.slice(0, eq), inline: token.slice(eq + 1) }
}

// 取值型参数：inline 形式直接取；否则吃掉下一个 token。缺值返回 null，由调用方报用法错误。
export function takeValue(argv, i, inlineValue) {
  if (inlineValue !== null) return { value: inlineValue, next: i }
  const next = argv[i + 1]
  if (next === undefined || next.startsWith('--')) return { value: null, next: i }
  return { value: next, next: i + 1 }
}

// 未知参数一律拒绝：拼错的开关（如 --dryrun）如果被静默忽略，工具会带着用户没想到的
// 默认值继续连库写数据。用法错误退出 1。
export function unknownArg(entry, token) {
  exitUsage(`未知参数 ${token}（${entry}）。运行 node tools/migrate-pg/src/${entry} --help 查看支持的参数。`)
}
