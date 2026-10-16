declare function require(id: string): any
declare namespace require {
  var cache: Record<string, any>
}
declare var module: { exports: any }
declare var process: {
  env: Record<string, string | undefined>
  platform: string
  argv: string[]
  pid: number
  execPath: string
  cwd(): string
  send?(message: any): boolean
  on?(event: string, listener: (...args: any[]) => void): void
  exit?(code?: number): never
  [key: string]: any
}
declare var __dirname: string
declare var __filename: string
declare var console: any
declare var Buffer: any
declare var TextDecoder: any
declare var fetch: any
declare var AbortController: any
declare function setTimeout(cb: (...args: any[]) => void, ms?: number): any
declare function clearTimeout(t: any): void
declare function setInterval(cb: (...args: any[]) => void, ms?: number): any
declare function clearInterval(t: any): void
