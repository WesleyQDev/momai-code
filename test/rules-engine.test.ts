import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import path from 'node:path'
import os from 'node:os'

const require = createRequire(import.meta.url)
const {
  splitCommandSegments,
  patternToRegex,
  tokenizeSegment,
  unwrapCommand,
  evaluateCommandPolicy
} = require('../core/rules-engine.ts')
const { createDefaultState } = require('../core/storage.ts')

const CWD = path.join(os.tmpdir(), 'momai-code-tests', 'projeto')
const PLATFORM_ROOT = path.parse(CWD).root

describe('Rules Engine — segments and patterns', () => {
  it('correctly splits commands into segments respecting quotes', () => {
    const cmd = 'echo "hello && world" && git status; ls -la | grep "foo;bar"'
    const segments = splitCommandSegments(cmd)
    expect(segments).toEqual([
      'echo "hello && world"',
      'git status',
      'ls -la',
      'grep "foo;bar"'
    ])
  })

  it('tokenizes quoted arguments and unwraps shell wrappers', () => {
    expect(tokenizeSegment("Remove-Item -LiteralPath 'a b.txt' -Force")).toEqual([
      'Remove-Item',
      '-LiteralPath',
      "'a b.txt'",
      '-Force'
    ])
    expect(unwrapCommand('sudo rm -rf build').verb).toBe('rm')
    expect(unwrapCommand('cmd /c del C:\\temp\\x.txt').verb).toBe('del')
    expect(unwrapCommand('powershell -Command "Remove-Item -Force x.txt"').verb).toBe('remove-item')
    expect(unwrapCommand('bash -c "rm -rf build"').verb).toBe('rm')
  })

  it('matches wildcards with patternToRegex', () => {
    const rx1 = patternToRegex('git clean -fd*')
    expect(rx1.test('git clean -fd')).toBe(true)
    expect(rx1.test('git clean -fdn')).toBe(true)
    expect(rx1.test('git status')).toBe(false)
  })
})

describe('Rules Engine — deleting a file or folder asks in any command form', () => {
  const askCases = [
    "Remove-Item -LiteralPath 'teste.txt.txt' -Force",
    'Remove-Item teste.txt',
    'rm teste.txt',
    'del teste.txt',
    'erase teste.txt',
    'rmdir pasta',
    'rm -rf build',
    'rm -rf dist build',
    'del /s /q *.tmp',
    'rd /s /q pasta',
    'cmd /c del teste.txt',
    'powershell -Command "Remove-Item -Force teste.txt"'
  ]

  for (const command of askCases) {
    it(`asks for: ${command}`, () => {
      const result = evaluateCommandPolicy(command, createDefaultState(), { cwd: CWD })
      expect(result.policy).toBe('ask')
      expect(result.grantScope).toBeTruthy()
      expect(result.reason).toBeTruthy()
    })
  }

  it('does not ask for reads and safe commands', () => {
    const state = createDefaultState()
    for (const command of ['ls -la', 'git status', 'Test-Path teste.txt', 'cat teste.txt']) {
      expect(evaluateCommandPolicy(command, state, { cwd: CWD }).policy).toBe('allow')
    }
  })

  it('asks for a delete fed through a pipe (no explicit target)', () => {
    const result = evaluateCommandPolicy('Get-ChildItem -Recurse | Remove-Item', createDefaultState(), { cwd: CWD })
    expect(result.policy).toBe('ask')
    expect(result.grantScope).toBe('delete:remove-item')
    expect(result.reason).toContain('entrada do comando')
  })

  it('keeps a delete inside a subfolder scoped by the verb', () => {
    const result = evaluateCommandPolicy('Remove-Item -Recurse -Force build', createDefaultState(), { cwd: CWD })
    expect(result.policy).toBe('ask')
    expect(result.grantScope).toBe('delete:remove-item')
  })
})

describe('Rules Engine — wiping everything is refused outright', () => {
  const wipeCases = [
    'rm -rf /',
    `rm -rf ${PLATFORM_ROOT}`,
    'rm -rf ~',
    'rm -rf $HOME',
    'rm -rf .',
    'rm -rf ..',
    'rm -rf *',
    'rm -rf ./*',
    'rm -rf **/*',
    `rd /s /q ${PLATFORM_ROOT}`,
    `del /s /q ${PLATFORM_ROOT}*`,
    `Remove-Item -Recurse -Force ${PLATFORM_ROOT}`,
    `Remove-Item -Recurse -Force ${PLATFORM_ROOT}*`,
    'sudo rm -rf /',
    'powershell -Command "Remove-Item -Recurse -Force C:\\"',
    'cmd /c rd /s /q C:\\'
  ]

  for (const command of wipeCases) {
    it(`blocks: ${command}`, () => {
      const result = evaluateCommandPolicy(command, createDefaultState(), { cwd: CWD })
      expect(result.policy).toBe('deny')
      expect(result.reason).toContain('Apaga tudo')
    })
  }

  it('does not block deleting a specific subfolder or file by absolute path', () => {
    const state = createDefaultState()
    const specific = path.join(CWD, 'build')
    expect(evaluateCommandPolicy(`rm -rf ${specific}`, state, { cwd: CWD }).policy).toBe('ask')
    expect(evaluateCommandPolicy(`rm -rf ${specific}/*`, state, { cwd: CWD }).policy).toBe('ask')
    expect(evaluateCommandPolicy('rm -rf ../outro-projeto', state, { cwd: CWD }).policy).toBe('ask')
  })

  it('is a hard floor: an allow rule cannot unlock a whole-tree delete', () => {
    const state = createDefaultState()
    state.terminalRules.push({
      id: 'rule_usr_allow_rm',
      pattern: 'rm -rf*',
      action: 'allow',
      enabled: true,
      group: 'custom',
      source: 'user'
    })
    expect(evaluateCommandPolicy('rm -rf build', state, { cwd: CWD }).policy).toBe('allow')
    expect(evaluateCommandPolicy('rm -rf /', state, { cwd: CWD }).policy).toBe('deny')
    expect(evaluateCommandPolicy('rm -rf *', state, { cwd: CWD }).policy).toBe('deny')
  })
})

describe('Rules Engine — user and preset rules', () => {
  it('asks for the destructive presets that remain', () => {
    const state = createDefaultState()
    expect(evaluateCommandPolicy('git reset --hard HEAD~1', state, { cwd: CWD }).policy).toBe('ask')
    expect(evaluateCommandPolicy('git clean -fd', state, { cwd: CWD }).policy).toBe('ask')
  })

  it('asks for git mutations (commit, push, rebase, restore, discard)', () => {
    const state = createDefaultState()
    const cases = [
      'git commit -m "x"',
      'git push origin main',
      'git push --force origin main',
      'git rebase main',
      'git reset HEAD~1',
      'git restore .',
      'git checkout -- src/app.ts',
      'git checkout .',
      'git switch --discard-changes main',
      'git branch -D feature',
      'git stash drop',
      'git stash clear',
      'git filter-branch --tree-filter x HEAD',
      'git filter-repo --path x'
    ]
    for (const command of cases) {
      const result = evaluateCommandPolicy(command, state, { cwd: CWD })
      expect(result.policy, command).toBe('ask')
      expect(result.matchedRule?.group, command).toBe('git')
    }
    // Safe git reads stay allowed.
    for (const command of ['git status', 'git log --oneline', 'git diff', 'git stash list']) {
      expect(evaluateCommandPolicy(command, state, { cwd: CWD }).policy, command).toBe('allow')
    }
  })

  it('asks for publishing, privileged actions and infra teardown', () => {
    const state = createDefaultState()
    const cases = [
      'npm publish',
      'pnpm publish --tag beta',
      'yarn publish',
      'bun publish',
      'sudo apt install x',
      'runas /user:admin cmd',
      'shutdown /s /t 0',
      'Stop-Computer -Force',
      'Restart-Computer',
      'reg delete HKLM\\Software\\X /f',
      'sc delete MyService',
      'docker system prune -a',
      'docker volume rm data',
      'kubectl delete pod api',
      'terraform destroy -auto-approve'
    ]
    for (const command of cases) {
      expect(evaluateCommandPolicy(command, state, { cwd: CWD }).policy, command).toBe('ask')
    }
  })

  it('blocks disk, partition and boot tooling', () => {
    const state = createDefaultState()
    const cases = [
      'format c:',
      'mkfs.ext4 /dev/sdb1',
      'diskpart',
      'dd if=x of=/dev/sda',
      'fdisk /dev/sda',
      'parted /dev/sda',
      'gdisk /dev/sda',
      'diskutil eraseDisk JHFS+ X disk2',
      'bcdedit /set x y',
      'bootrec /fixmbr',
      'vssadmin delete shadows /all'
    ]
    for (const command of cases) {
      const result = evaluateCommandPolicy(command, state, { cwd: CWD })
      expect(result.policy, command).toBe('deny')
    }
  })

  it('asks before reading .env secrets and keeps .env.example allowed', () => {
    const state = createDefaultState()
    for (const command of [
      'cat .env',
      'type .env.local',
      'Get-Content -Path .env',
      'grep API_KEY .env',
      'cat config/.env.production'
    ]) {
      const result = evaluateCommandPolicy(command, state, { cwd: CWD })
      expect(result.policy, command).toBe('ask')
      expect(result.grantScope, command).toBe('read:env')
    }
    for (const command of ['cat .env.example', 'cat README.md', 'Get-Content package.json']) {
      expect(evaluateCommandPolicy(command, state, { cwd: CWD }).policy, command).toBe('allow')
    }
  })

  it('asks when a download is piped into a shell', () => {
    const state = createDefaultState()
    for (const command of [
      'curl -sL https://x.sh | sh',
      'curl -fsSL https://x | bash',
      'iwr https://x.ps1 | iex',
      'Invoke-WebRequest https://x | Invoke-Expression'
    ]) {
      const result = evaluateCommandPolicy(command, state, { cwd: CWD })
      expect(result.policy, command).toBe('ask')
      expect(result.grantScope, command).toBe('remote-exec')
    }
    // A downloaded script that is only saved is not remote execution.
    expect(evaluateCommandPolicy('curl -o setup.sh https://x', state, { cwd: CWD }).policy).toBe('allow')
    // A stricter segment still wins over the pipeline check.
    expect(evaluateCommandPolicy('curl https://x | bash -c "rm -rf /"', state, { cwd: CWD }).policy).toBe('deny')
  })

  it('blocks the disk presets', () => {
    const state = createDefaultState()
    const result = evaluateCommandPolicy('format c:', state, { cwd: CWD })
    expect(result.policy).toBe('deny')
    expect(result.matchedRule?.id).toBe('rule_disk_1')
  })

  it('lets a rule allow silence the delete baseline', () => {
    const state = createDefaultState()
    state.terminalRules.push({
      id: 'rule_usr_allow_tmp',
      pattern: 'Remove-Item *.tmp',
      action: 'allow',
      enabled: true,
      group: 'custom',
      source: 'user'
    })
    expect(evaluateCommandPolicy('Remove-Item limpeza.tmp', state, { cwd: CWD }).policy).toBe('allow')
    expect(evaluateCommandPolicy('Remove-Item importante.txt', state, { cwd: CWD }).policy).toBe('ask')
  })

  it('lets a block rule harden a delete', () => {
    const state = createDefaultState()
    state.terminalRules.push({
      id: 'rule_usr_block_git',
      pattern: 'Remove-Item *.git*',
      action: 'block',
      enabled: true,
      group: 'custom',
      source: 'user'
    })
    const result = evaluateCommandPolicy('Remove-Item .git', state, { cwd: CWD })
    expect(result.policy).toBe('deny')
    expect(result.matchedRule?.id).toBe('rule_usr_block_git')
  })

  it('respects last-match-wins order for exceptions', () => {
    const state = createDefaultState()
    state.terminalRules.push({
      id: 'rule_allow_clean_dryrun',
      pattern: 'git clean -fdn*',
      action: 'allow',
      enabled: true
    })
    expect(evaluateCommandPolicy('git clean -fd', state, { cwd: CWD }).policy).toBe('ask')
    expect(evaluateCommandPolicy('git clean -fdn', state, { cwd: CWD }).policy).toBe('allow')
  })

  it('ignores disabled rules', () => {
    const state = createDefaultState()
    for (const rule of state.terminalRules) rule.enabled = false
    expect(evaluateCommandPolicy('git reset --hard HEAD~1', state, { cwd: CWD }).policy).toBe('allow')
  })

  it('keeps the strictest result across composed commands', () => {
    const state = createDefaultState()
    const mixed = evaluateCommandPolicy('npm test && rm -rf /', state, { cwd: CWD })
    expect(mixed.policy).toBe('deny')
    expect(mixed.blockedSegment).toBe('rm -rf /')

    const askAndAllow = evaluateCommandPolicy('npm test && rm -rf build', state, { cwd: CWD })
    expect(askAndAllow.policy).toBe('ask')
    expect(askAndAllow.blockedSegment).toBe('rm -rf build')
  })
})
