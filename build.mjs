import { context } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const outdir = path.join(root, 'dist')
const isWatch = process.argv.includes('--watch')

const external = ['react', 'react-dom', 'react/jsx-runtime', 'momai:sdk']

const uiContexts = []
for (const entry of ['src/page.tsx', 'src/chat-project.tsx']) {
  const name = path.basename(entry, '.tsx')
  uiContexts.push(
    await context({
      entryPoints: [path.join(root, entry)],
      outfile: path.join(outdir, `${name}.js`),
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2020',
      external,
      sourcemap: false,
      logLevel: 'warning'
    })
  )
}

async function buildAll() {
  await Promise.all(uiContexts.map((ctx) => ctx.rebuild()))
  console.log('[momai-code] build done')
}

await buildAll()

if (isWatch) {
  await Promise.all(uiContexts.map((ctx) => ctx.watch()))
  console.log('[momai-code] watching for changes…')
} else {
  await Promise.all(uiContexts.map((ctx) => ctx.dispose()))
}
