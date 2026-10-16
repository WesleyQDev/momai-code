export interface SDKResponse<T = any> {
  ok: boolean
  data?: T
  error?: string
  errorCode?: string
  message?: string
}

export interface MomAISDK {
  api: {
    get<T = any>(path: string, params?: Record<string, any>): Promise<SDKResponse<T>>
    post<T = any>(path: string, body?: any): Promise<SDKResponse<T>>
    put<T = any>(path: string, body?: any): Promise<SDKResponse<T>>
    delete<T = any>(path: string): Promise<SDKResponse<T>>
  }
  events: {
    subscribe<T = any>(type: string, handler: (data: T) => void): () => void
    unsubscribe(type: string, handler: (...args: any[]) => void): void
  }
  registry: {
    registerRenderer(type: string, component: any): void
  }
  i18n?: {
    getLocale?: () => string
    onLocaleChange?: (handler: (locale: string) => void) => () => void
  }
  clipboard?: {
    readText?: () => Promise<string>
  }
  dialog?: {
    selectDirectory: (options?: {
      title?: string
      buttonLabel?: string
      defaultPath?: string
    }) => Promise<{ canceled: boolean; path?: string | null }>
  }
}

export declare function getSDK(): MomAISDK
