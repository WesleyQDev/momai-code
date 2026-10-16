function codedError(code: string, message: string) {
  const err: any = new Error(message)
  err.code = code
  return err
}

function _createIpcCodeStorage({ send, onResponse, storageDir, timeoutMs = 30000 }: any = {}) {
  let seq = 0
  const pending = new Map<string, { resolve: (val: any) => void; reject: (err: any) => void; timer: NodeJS.Timeout }>()

  onResponse((msg: any) => {
    if (!msg || msg.type !== 'storage-response' || !msg.requestId) return
    const entry = pending.get(msg.requestId)
    if (!entry) return
    pending.delete(msg.requestId)
    clearTimeout(entry.timer)
    const result = msg.result || {}
    if (result.ok === false) {
      entry.reject(codedError(result.errorCode || 'storage_error', result.error || 'storage request failed'))
      return
    }
    entry.resolve(result.value)
  })

  function call(method: string, args: any[]) {
    return new Promise((resolve, reject) => {
      const requestId = 'code-' + Date.now() + '.' + seq++
      const timer = setTimeout(() => {
        pending.delete(requestId)
        reject(new Error('storage IPC timeout: ' + method))
      }, timeoutMs)
      if (timer.unref) timer.unref()
      pending.set(requestId, { resolve, reject, timer })
      try {
        send({ type: 'storage-request', requestId, method, args, extensionId: 'momai-code' })
      } catch (err) {
        pending.delete(requestId)
        clearTimeout(timer)
        reject(err)
      }
    })
  }

  function area(prefix: string, methods: string[]) {
    return Object.fromEntries(methods.map((name) => [name, (...args: any[]) => call(prefix + '.' + name, args)]))
  }

  const storageMethods = area('storage', ['get', 'set', 'getMany', 'setMany', 'delete', 'listKeys', 'migrate'])

  return {
    storage: {
      storageDir,
      get: storageMethods.get,
      set: async (key: string, value: any, opts?: any) => {
        await call('storage.set', opts === undefined ? [key, value] : [key, value, opts])
      },
      delete: storageMethods.delete,
      listKeys: storageMethods.listKeys
    }
  }
}

module.exports = {
  createIpcCodeStorage: _createIpcCodeStorage
}
