#!/usr/bin/env node
/**
 * dsh-optimizer client 构建
 * DSH 的 client 插件半部要求 `window.__ModuleLoader__.load({ id, factory })`
 * 包装格式（esbuild CJS bundle）——普通 ESM 产物不会被 client 运行时装载。
 * 参考 dsh-learn-everything 的 scripts/build-client.mjs。
 */
import { build } from 'esbuild'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pluginId = 'dsh-optimizer'

await build({
  entryPoints: [join(repo, 'src', 'client.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['es2022'],
  outfile: join(repo, 'lib', 'client.js'),
  banner: {
    js: `window.__ModuleLoader__.load({ id: "${pluginId}", factory: (require) => { var module = { exports: {} }; var exports = module.exports;`,
  },
  footer: { js: 'return module.exports; } });' },
  define: { 'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production') },
  logLevel: 'info',
})

console.log('[dsh-optimizer] client bundle built -> lib/client.js')
