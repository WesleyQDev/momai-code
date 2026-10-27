import { describe, it, expect, vi } from 'vitest'

vi.mock('momai:sdk', () => ({
  getSDK: () => ({
    i18n: {
      getLocale: () => 'pt-BR',
      onLocaleChange: () => () => {}
    }
  })
}))

import { STRINGS } from '../src/hooks/useI18n.ts'

describe('chat project selector i18n coverage', () => {
  const supportedLocales = ['pt-BR', 'en-US', 'es', 'fr', 'de', 'it']

  it('declares projects.noProject, projects.openingFolder and chat.noGit in all 6 locales', () => {
    for (const locale of supportedLocales) {
      const dict = STRINGS[locale]
      expect(dict, `locale ${locale} should exist in STRINGS`).toBeDefined()
      expect(dict['projects.noProject'], `projects.noProject in ${locale}`).toBeTruthy()
      expect(dict['projects.openingFolder'], `projects.openingFolder in ${locale}`).toBeTruthy()
      expect(dict['chat.noGit'], `chat.noGit in ${locale}`).toBeTruthy()
    }
  })

  it('translates "projects.noProject" correctly across languages', () => {
    expect(STRINGS['pt-BR']['projects.noProject']).toBe('Sem Projeto')
    expect(STRINGS['en-US']['projects.noProject']).toBe('No Project')
    expect(STRINGS['es']['projects.noProject']).toBe('Sin proyecto')
    expect(STRINGS['fr']['projects.noProject']).toBe('Sans projet')
    expect(STRINGS['de']['projects.noProject']).toBe('Kein Projekt')
    expect(STRINGS['it']['projects.noProject']).toBe('Senza progetto')
  })

  it('translates "chat.noGit" correctly across languages', () => {
    expect(STRINGS['pt-BR']['chat.noGit']).toBe('Sem git')
    expect(STRINGS['en-US']['chat.noGit']).toBe('No git')
    expect(STRINGS['es']['chat.noGit']).toBe('Sin git')
    expect(STRINGS['fr']['chat.noGit']).toBe('Sans git')
    expect(STRINGS['de']['chat.noGit']).toBe('Kein Git')
    expect(STRINGS['it']['chat.noGit']).toBe('Senza git')
  })
})
