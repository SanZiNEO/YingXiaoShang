import net from 'node:net'

export function allocatePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('未能从操作系统分配到端口')))
        return
      }
      const port = address.port
      server.close(() => resolvePort(port))
    })
  })
}

export function isPortFree(port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolveCheck) => {
    const socket = net.connect({ port, host: '127.0.0.1' })
    let settled = false
    const finish = (free: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolveCheck(free)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(false))
    socket.once('timeout', () => finish(true))
    socket.once('error', () => finish(true))
  })
}

export async function waitPortFree(port: number, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isPortFree(port)) return true
    await delay(120)
  }
  return isPortFree(port)
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}
