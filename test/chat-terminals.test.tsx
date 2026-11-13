import { describe, it, expect, vi } from 'vitest'

vi.mock('momai:sdk', () => ({
  default: {},
  getSDK: () => ({
    i18n: {
      getLocale: () => 'pt-BR',
      onLocaleChange: () => () => {}
    }
  })
}))

import { renderToStaticMarkup } from 'react-dom/server'
import ChatTerminals from '../src/chat-terminals.tsx'

// Effects never run under renderToStaticMarkup, so the list stays at its
// initial state (no processes). That is exactly the resting state the badge
// must not show.
const emptySdk = { api: { post: async () => ({ processes: [] }) } }

describe('chat terminals badge visibility', () => {
  it('renders nothing when there are no background processes', () => {
    const html = renderToStaticMarkup(
      <ChatTerminals threadId="t1" extensionId="momai-code" sdk={emptySdk} />
    )
    expect(html).toBe('')
  })

  it('renders nothing without an extension route', () => {
    const html = renderToStaticMarkup(<ChatTerminals threadId="t1" sdk={emptySdk} />)
    expect(html).toBe('')
  })

  it('renders with fine colored line and pulsing animation when background shells are running', () => {
    const running = {
      id: 'bg-test',
      pid: 9999,
      command: 'npm run dev',
      cwd: '/workspace',
      status: 'running',
      outputFile: '/tmp/test.log'
    }
    const html = renderToStaticMarkup(
      <ChatTerminals
        threadId="t1"
        extensionId="momai-code"
        sdk={emptySdk}
        initialProcesses={[running]}
      />
    )
    expect(html).toContain('animate-pulse')
    expect(html).toContain('text-accent')
    expect(html).toContain('border-accent/40')
    expect(html).toContain('stroke-width="1.5"')
    expect(html).toContain('1 Shell')
  })
})

describe('chat terminals badge copy', () => {
  const locales = ['pt-BR', 'en-US', 'es', 'fr', 'de', 'it']

  it('declares the shell count label in all 6 locales', async () => {
    const { STRINGS } = await import('../src/hooks/useI18n.ts')
    for (const locale of locales) {
      expect(STRINGS[locale]['terminals.shells.one'], `one in ${locale}`).toContain('{count}')
      expect(STRINGS[locale]['terminals.shells.other'], `other in ${locale}`).toContain('{count}')
    }
  })
})
