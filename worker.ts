const wpath = require('node:path')
const { createIpcCodeStorage } = require('./core/ipc-storage.ts')
const runtime = require('./runtime.ts')

const [skillId, skillPath] = process.argv.slice(2)

const dataDir =
  process.env.MOMAI_DATA_DIR ||
  process.env.MOMAI_NODE_CORE_DATA_DIR ||
  wpath.resolve(__dirname, '..', '..', 'data')

const storageBase = wpath.join(dataDir, 'extensions', skillId || 'momai-code')

let storageResponseListener: ((msg: any) => void) | null = null
const ipcBridge = createIpcCodeStorage({
  send: (msg: any) => send(msg),
  onResponse: (fn: (msg: any) => void) => {
    storageResponseListener = fn
  },
  storageDir: storageBase
})

const storage = ipcBridge.storage

function send(msg: any) {
  try {
    if (typeof process.send === 'function') process.send(msg)
  } catch {
    /* host unreachable */
  }
}

const momai = {
  log: (message: any) => send({ type: 'log', message: String(message) }),
  sendEvent: (eventType: string, data: any) => send({ type: 'event', eventType, data }),
  sendStructuredResponse: (data: any) => send({ type: 'event', eventType: 'structured_response', data }),
  storage
}

let isShuttingDown = false

async function shutdown() {
  if (isShuttingDown) return
  isShuttingDown = true
  // Background terminals started by this extension must not outlive the app.
  try {
    require('./core/processes.ts').stopAllProcesses()
  } catch {
    /* cleanup must never block the shutdown */
  }
  process.exit?.(0)
}

process.on?.('SIGTERM', () => shutdown())
process.on?.('SIGINT', () => shutdown())
// The host is gone without a goodbye (crash, tree-kill on quit): the closing
// IPC channel is the only signal left. Clean up the same way as shutdown.
process.on?.('disconnect', () => shutdown())
process.on?.('exit', () => {
  if (isShuttingDown) return
  isShuttingDown = true
  try {
    require('./core/processes.ts').stopAllProcesses()
  } catch {
    /* cleanup must never block the shutdown */
  }
})

process.on?.('message', async (msg: any) => {
  if (!msg || typeof msg !== 'object') return

  if (msg.type === 'storage-response') {
    try {
      if (typeof storageResponseListener === 'function') storageResponseListener(msg)
    } catch {
      /* listener errors stay local */
    }
    return
  }

  if (msg.type === 'shutdown') {
    await shutdown()
    return
  }

  if (msg.type !== 'execute') return

  const { requestId, payload } = msg
  try {
    const result = await runtime.execute({ ...(payload || {}), momai })
    send({ type: 'response', requestId, result: result || { ok: true } })
  } catch (err: any) {
    send({
      type: 'response',
      requestId,
      result: { ok: false, error: err?.message || String(err) }
    })
  }
})

// A previous generation may have died without cleanup (hard kill on reload,
// app quit, crash): such shells are still marked running, and a shell that
// returned while its command kept serving leaves the command reachable only
// through it. Reap them, but after `ready` so startup is never delayed.
setTimeout(() => {
  try {
    const reaped = require('./core/processes.ts').reapOrphanedProcesses()
    if (reaped > 0) momai.log(`Finalizados ${reaped} processo(s) em segundo plano de sessão anterior.`)
  } catch {
    /* a dirty store must never break the worker */
  }
}, 0)

// Signal host that persistent worker is initialized and ready
send({ type: 'ready', worker: 'momai-code' })
