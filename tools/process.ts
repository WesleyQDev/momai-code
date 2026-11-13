import type { ToolContext, CodeStateManager } from '../core/types.ts'
const { listProcesses, getProcess, stopProcess, readOutput } = require('../core/processes.ts')

interface ProcessView {
  id: string
  pid: number
  command: string
  cwd: string
  status: string
  runningSeconds?: number
  exitCode?: number | null
  outputFile: string
}

function toView(entry: any): ProcessView {
  const ended = entry.status !== 'running'
  return {
    id: entry.id,
    pid: entry.pid,
    command: entry.command,
    cwd: entry.cwd,
    status: entry.status,
    runningSeconds: ended
      ? undefined
      : Math.max(0, Math.round((Date.now() - entry.startedAt) / 1000)),
    exitCode: entry.exitCode,
    outputFile: entry.file
  }
}

/** Same payload the agent reads and the chat UI renders. */
function respond(data: Record<string, any>): any {
  return { ...data, instruction: JSON.stringify(data) }
}

/**
 * Terminal processes running outside a tool call.
 *
 * `list` shows what is still running, `output` reads the tail of its log and
 * `stop` kills the whole tree. The same tool is exposed as an HTTP route so the
 * chat UI can show the list and stop a process without asking the agent.
 */
async function executeCodeProcess(
  args: Record<string, any>,
  _stateManager?: CodeStateManager,
  context?: ToolContext
): Promise<any> {
  const action = String(args.action || 'list').trim().toLowerCase()
  const id = String(args.id || args.shellID || '').trim()

  if (action === 'list') {
    const includeEnded = args.includeEnded === true
    // The chat UI posts its thread in the body; agent calls carry it in the
    // context. Either way the list only shows that conversation's shells.
    const threadId =
      typeof args.threadId === 'string' && args.threadId ? args.threadId : context?.threadId
    const processes = listProcesses({ includeEnded, threadId }).map(toView)
    return respond({
      ok: true,
      count: processes.length,
      running: processes.filter((entry) => entry.status === 'running').length,
      processes
    })
  }

  if (!id) {
    return { ok: false, error: 'Parâmetro obrigatório ausente: id (shellID do processo).' }
  }

  if (action === 'output') {
    const limit = typeof args.limitBytes === 'number' ? args.limitBytes : undefined
    const result = readOutput(id, limit)
    if (!result.ok) return { ok: false, error: result.error }

    const entry = getProcess(id)
    return respond({
      ok: true,
      id,
      status: entry?.status || 'unknown',
      output: result.output
    })
  }

  if (action === 'stop' || action === 'kill') {
    const result = stopProcess(id)
    if (!result.ok) return { ok: false, error: result.error }
    return respond({
      ok: true,
      id,
      status: 'stopped',
      message: `Processo ${id} encerrado.`
    })
  }

  return {
    ok: false,
    error: `Ação desconhecida: ${action}. Use list, output ou stop.`
  }
}

module.exports = {
  executeCodeProcess
}
