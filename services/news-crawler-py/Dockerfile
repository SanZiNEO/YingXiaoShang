# ---- builder: resolve dependencies and build local wheels (discarded after this stage) ----
FROM python:3.12-slim AS builder

WORKDIR /build

ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

COPY pyproject.toml uv.lock ./
COPY src ./src

RUN pip wheel --wheel-dir /wheels .

# ---- runtime: installed package and runtime dependencies only ----
FROM python:3.12-slim AS runtime

WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

COPY --from=builder /wheels /wheels
RUN pip install --no-index --find-links=/wheels news-crawler==0.1.0 \
    && rm -rf /wheels
COPY src ./src

RUN groupadd -g 10001 app \
    && useradd -u 10001 -g 10001 -m app \
    && mkdir -p /data/data \
    && chown -R 10001:10001 /app /data

USER 10001

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["python", "-c", "import json,sys,urllib.request; r=urllib.request.urlopen('http://127.0.0.1:8787/health',timeout=5); b=json.loads(r.read().decode('utf-8')); sys.exit(0 if r.status==200 and b.get('ok') is True else 1)"]

CMD ["news-crawler", "serve", "--host", "0.0.0.0", "--db", "/data/data/learning.db"]
