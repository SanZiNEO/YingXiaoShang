// @yxs/migrate-pg · pg-driver.js
//
// `pg` 只在真正要连库时才加载。三个入口的用法校验、源路径校验、目标库守卫、注册表漂移
// 核对全都不需要驱动；若在模块顶层静态 `import pg`，一份还没装依赖的干净克隆连
// `--help` 和缺参提示都跑不到，只会吐英文 ERR_MODULE_NOT_FOUND 堆栈。
// 依赖缺失属于环境问题（退出码 2），按契约给中文消息并指出安装命令。

import { exitEnv } from './cli.js'

let cached = null

export async function loadPg() {
  if (cached) return cached
  try {
    cached = await import('pg')
  } catch (err) {
    if (err && (err.code === 'ERR_MODULE_NOT_FOUND' || err.code === 'MODULE_NOT_FOUND')) {
      exitEnv(
        '缺少 PostgreSQL 驱动 pg：请先在 tools/migrate-pg/ 下执行 pnpm install --ignore-workspace。',
      )
    }
    throw err
  }
  return cached
}
