import { createApp } from './app.js'
import { buildContext } from './context.js'
import { loadEnv, prepareWorkspace } from './env.js'
import { createLogger, runtimeLog } from './log.js'
import { createMetrics } from './metrics.js'
import type { Services } from './services.js'

async function listen(server: ReturnType<typeof createApp>, host: string, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}

async function main(): Promise<void> {
  let env
  let services: Services | undefined
  const log = createLogger()
  const metrics = createMetrics()
  try {
    env = loadEnv()
    prepareWorkspace(env)
    services = await buildContext(env, metrics, log)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`${message}\n`)
    process.exitCode = 2
    return
  }

  const server = createApp(services, { corsOrigins: env.corsOrigins })
  try {
    await listen(server, env.host, env.port)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      process.stderr.write(`端口 ${env.port} 已被占用，换 YXS_SERVER_PORT 再试。\n`)
      process.exitCode = 3
    } else {
      process.stderr.write(`服务启动失败：${message}\n`)
      process.exitCode = 1
    }
    services.auth.close()
    return
  }

  runtimeLog('server_started', {
    host: env.host,
    port: env.port,
    home: env.home,
    llm: env.llm,
    db: env.dbPath,
  })

  let closing = false
  const shutdown = (signal: string): void => {
    if (closing) return
    closing = true
    runtimeLog('server_stopping', { signal })
    server.close(() => {
      services?.auth.close()
      runtimeLog('server_stopped', { signal })
      process.exit(0)
    })
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
})
