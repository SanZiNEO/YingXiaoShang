# syntax=docker/dockerfile:1
#
# yxs-server:local — 多阶段构建，非 root。
# build context = 仓库根（冻结 §10.4）：apps/server 通过 workspace:* 依赖 packages/*，
# 只给 apps/server 上下文装不出依赖。

# ---------- 阶段 1：装依赖 + 编译 ----------
FROM node:22-slim AS build

WORKDIR /app

# 与根 package.json 的 packageManager 对齐；改版本时两处一起改。
RUN corepack enable && corepack prepare pnpm@11.28.5 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps/server ./apps/server
# 种子库由 pipeline 从 data/normalized 生成（离线、确定性）；首次启动即 13 章，
# /health 直接 200，不会因为空库被判不健康。
COPY pipeline ./pipeline
COPY data/normalized ./data/normalized

# 只装服务端及其 workspace 依赖。根 package.json 里的 playwright / electron / cheerio
# 与镜像无关，全量装既慢又会把它们带进构建层。
# --ignore-scripts：本依赖图没有需要编译的原生模块（SQLite 走 node:sqlite 内置，
# esbuild 的二进制来自 @esbuild/<platform> 可选依赖），而 pnpm 11 遇到未批准的构建
# 脚本会以退出码 1 终止安装，直接卡死构建。
RUN pnpm install --frozen-lockfile --filter '@yxs/server...' --ignore-scripts

# 按依赖拓扑编译。-r --filter 顺着项目引用把 export / llm-json / artifacts 这类
# 「不在服务端 dependencies 里、只被引用」的包一起编出来；逐个 pnpm --dir 列举必漏。
RUN pnpm -r --filter '@yxs/server...' build

# 契约文件由编译产物生成，不从仓库拷一份可能过期的：
# 生成器的唯一来源是 src/rpc/registry.ts 的 METHODS（03-implementation §3.10）。
RUN pnpm --dir apps/server run gen:openapi

# 首次启动的种子库：从 data/normalized 离线生成（规则打标，不联网、不用 API key）。
# 内置它，全新数据卷第一次起来就是 13 章，/health 直接 200，不必手工跑 db:seed。
RUN LEARNING_AGENT_HOME=/seed pnpm exec tsx pipeline/seed-db.ts

# 打出自包含运行时目录。pnpm deploy 把 workspace 依赖铺平进目标 node_modules；
# --node-linker=hoisted 保证产物里没有指向 .pnpm 的符号链接（符号链接跨阶段拷贝会失效）。
RUN pnpm --filter @yxs/server deploy --prod --node-linker=hoisted --ignore-scripts /runtime

# 只留运行时真正需要的字节：deploy 生成的 lockfile / manifest 里写死了构建机的绝对路径，
# 源码与测试已在 lib 里编好，.bin 与虚拟仓库元数据运行时用不到。
RUN rm -rf /runtime/src /runtime/test /runtime/scripts /runtime/docs /runtime/tsconfig.json \
           /runtime/README.md /runtime/Dockerfile /runtime/pnpm-lock.yaml /runtime/pnpm-workspace.yaml \
           /runtime/node_modules/.bin /runtime/node_modules/.pnpm \
           /runtime/node_modules/.modules.yaml /runtime/node_modules/.pnpm-workspace-state-v1.json

# ---------- 阶段 2：运行时，非 root ----------
FROM node:22-slim AS runtime

WORKDIR /app

# 容器内布局（冻结 §10.1 / §10.3）。YXS_SERVER_HOST 必须显式给：
# env.ts 的默认值是 127.0.0.1，容器内绑回环会让 8080:8080 映射形同虚设。
ENV NODE_ENV=production \
    LEARNING_AGENT_HOME=/data \
    LEARNING_AGENT_PROMPTS_DIR=/app/packages/agent \
    YXS_TEMPLATES_DIR=/app/templates \
    YXS_SERVER_HOST=0.0.0.0 \
    YXS_SERVER_PORT=8080 \
    YXS_SEED_DB=seed/learning.db

RUN groupadd -g 10001 yxs \
 && useradd -u 10001 -g 10001 -M -d /data -s /usr/sbin/nologin yxs \
 && mkdir -p /data \
 && chown 10001:10001 /data

# lib + 已铺平的 node_modules。放在 apps/server 下，prom-client / yaml / @deepseek-ai/dsh-llm
# 才能从 apps/server/lib/index.js 逐级上溯命中（pnpm 的 per-importer 链接不会跟过来）。
COPY --from=build /runtime/lib ./apps/server/lib
COPY --from=build /runtime/node_modules ./apps/server/node_modules
# 用仓库里的原始 manifest：deploy 生成的那份把 workspace:* 改写成了 file: 绝对路径。
COPY apps/server/package.json ./apps/server/package.json

# 提示词是内容不是代码，不在任何包的 files 里，deploy 不会带出来。
# env.ts 只校验 agents/mentor.md，prompts.ts 另外读 references/*.md。
COPY --from=build /app/packages/agent/agents ./packages/agent/agents
COPY --from=build /app/packages/agent/references ./packages/agent/references

# env.ts 启动强校验该文件存在；GET /api/v1/openapi.yaml 直接读它。
COPY --from=build /app/docs/contracts/openapi.yaml ./docs/contracts/openapi.yaml

# 空卷首次启动时 env.ts 会把它复制成 /data/data/learning.db（YXS_SEED_DB 是相对
# REPO_ROOT=/app 的路径，所以这里必须落在 /app/seed）。
COPY --from=build /seed/data/learning.db ./seed/learning.db

COPY apps/desktop/templates ./templates

USER 10001
EXPOSE 8080

# 判据按冻结 §7.5：503 = 不健康（DB 打不开或数据缺失）。镜像内置种子库，
# 所以全新卷首次启动就是 200；用内置 fetch（Node 22 稳定），slim 镜像没有 curl 也不用装。
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.YXS_SERVER_PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/server/lib/index.js"]
