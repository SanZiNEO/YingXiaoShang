# @learning-agent/web

把桌面版 React 界面（`apps/desktop/src/renderer`）直接复用到浏览器中，由同一个 Node 进程提供 HTTP API 和静态前端。服务端初始化与桌面主进程一致：同一个 SQLite 数据库、同一组 Agent 服务、同一个 DeepSeek 配置。

## 构建与启动

```bash
pnpm install

# 首次部署：把课程数据与 student_demo 装入持久目录
LEARNING_AGENT_HOME="$PWD/.learning-agent" pnpm db:seed
LEARNING_AGENT_HOME="$PWD/.learning-agent" pnpm db:seed:student

# 构建前端到 apps/web/dist
pnpm --dir apps/web build

# 启动 API + 静态站点（默认 127.0.0.1:3081）
LEARNING_AGENT_HOME="$PWD/.learning-agent" pnpm --dir apps/web start
```

也可以直接用根目录脚本：`pnpm web:build`（构建全部包 + 前端）和
`pnpm web:start`（启动 Web 服务）。

开发时前后端分开运行：

```bash
# 终端 1：API，端口 3081
LEARNING_AGENT_HOME="$PWD/.learning-agent" pnpm --dir apps/web start

# 终端 2：Vite，端口 5173，/api 自动代理到 3081
pnpm --dir apps/web dev
```

打开 `http://localhost:5173`（开发）或 `http://localhost:3081`（构建产物）。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `LEARNING_AGENT_WEB_PORT` | `3081` | 监听端口 |
| `LEARNING_AGENT_WEB_HOST` | `127.0.0.1` | 非回环监听必须同时设置访问令牌 |
| `LEARNING_AGENT_HOME` | `~/.learning-agent` | 数据目录；容器内为 `/data` |
| `LEARNING_AGENT_ACCESS_TOKEN` | 空（仅限回环访问） | 设置后所有 `/api/*` 都要求 `Authorization: Bearer <token>` |
| `LEARNING_AGENT_NEWS_REFRESH_MINUTES` | `30` | 新闻自动刷新间隔（分钟） |
| `DEEPSEEK_API_KEY` | 空 | 覆盖设置文件中的 DeepSeek Key |
| `DEEPSEEK_MODEL` | `deepseek-chat` | 覆盖设置文件中的模型名 |

## 数据持久化

所有状态都在 `LEARNING_AGENT_HOME` 下：

- SQLite 数据库（学生、会话、证据、记忆、新闻等）
- `artifacts/`：生成的学习产物
- `exports/`：导出的 md/docx
- `settings.json`：DeepSeek Key 与模型；设置接口只返回是否配置，不回传 Key

该目录是唯一的数据根：备份、迁移、清理都只针对它。

## 访问令牌

不设置 `LEARNING_AGENT_ACCESS_TOKEN` 时仅允许回环监听。尝试绑定 `0.0.0.0` 或
非回环地址且缺少令牌，服务会拒绝启动，不能把未鉴权的学生数据暴露到局域网。

设置令牌后：

1. 首次访问页面时带 `?token=<URL 编码的 token>`；前端保存后从地址栏移除；
2. 之后所有请求自动附带 `Authorization: Bearer <token>`；
3. `/api/health` 同样需要令牌。

```bash
LEARNING_AGENT_ACCESS_TOKEN='change-me' pnpm --dir apps/web start
# 浏览器打开 http://localhost:3081/?token=change-me
```

这是单用户共享令牌，不区分账号，也不替代 TLS。公网部署必须放在 HTTPS 反向代理之后。

页面设置区分本地保存的 Key 与环境变量配置。清除本地 Key 不会清除进程中的
`DEEPSEEK_API_KEY`，页面会返回并显示实际仍生效的配置；不会误报“已断开”。

## 反向代理

聊天请求会同步等待模型返回，可能持续数十秒到数分钟；代理需要放宽读超时，并允许请求体（设置、答题集）通过。

Nginx 示例：

```nginx
server {
    listen 443 ssl;
    server_name learning.example.com;

    ssl_certificate     /etc/letsencrypt/live/learning.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/learning.example.com/privkey.pem;

    client_max_body_size 4m;

    location / {
        proxy_pass http://127.0.0.1:3081;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
```

Caddy 示例：

```caddyfile
learning.example.com {
    reverse_proxy 127.0.0.1:3081 {
        transport http {
            read_timeout 300s
        }
    }
}
```

健康检查：`GET /api/health`（设置令牌时需带 Bearer）。

## 部署

当前 MVP 直接以进程方式长驻运行（`pnpm --dir apps/web start`），用 systemd、supervisor
或计划任务守护即可。容器化部署不在 MVP 范围；如需自行容器化，把 `LEARNING_AGENT_HOME`
挂载为持久卷，并保证运行用户对该目录可写。

种子脚本 `db:seed` / `db:seed:student` 是幂等的，中断后可安全重跑，已有学生档案、
学习计划和记忆不会被覆盖。

## 与桌面版的差异

- 本地文件选择/任意路径预览/打开目录不可用；界面会隐藏这些操作，而不是让学生点击后收到 501。产物 Markdown/Word 通过鉴权下载接口直接下载到浏览器。
- 设置保存在 `LEARNING_AGENT_HOME/settings.json`，不再使用 Electron 的 `userData` 目录。
- 前端与桌面版共用同一份 `App.tsx` 和 `styles.css`，避免两套界面分叉。
