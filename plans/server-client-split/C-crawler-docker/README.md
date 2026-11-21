# C · 采集服务 Docker 化

## 要实现

- 采集服务 `Dockerfile`：`python:3.12-slim`，只装 `httpx/beautifulsoup4/lxml`，不含 Playwright。
- 采集镜像非 root 运行，暴露 `8787`，带 `/health` 健康检查。
- `.dockerignore` 排除 `.venv`、`.data`、测试缓存、测试数据。
- `services/deploy/compose.yml`：采集服务 + 应用服务 + 数据卷 + 健康检查。
- 采集服务只写 `news_articles`、`source_runs`、`news_tags`。
- 30 分钟一轮的 cron 示例和单轮执行脚本。
- 重启容器、`down` 再 `up`（不带 `-v`）后数据仍在。
- 采集镜像小于 400MB。

## 产出

```text
services/news-crawler-py/Dockerfile
services/news-crawler-py/.dockerignore
services/deploy/compose.yml
services/deploy/.env.example
services/deploy/cron/news-crawler.cron
services/deploy/scripts/run-round.sh
services/deploy/scripts/healthcheck.sh
```
