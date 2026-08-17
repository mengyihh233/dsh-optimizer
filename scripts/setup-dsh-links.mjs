#!/usr/bin/env node
/**
 * dsh-optimizer setup-dsh-links
 *
 * bundle 插件的 host 半部运行时 import @deepseek-ai/dsh-tools 与
 * @deepseek-ai/cordis。在 link 缓存安装模式（dshpm 把 git 仓库 clone 到
 * plugin-manager-src 后直接执行）下，插件的 node_modules 里没有这些内部包，
 * Node 从缓存目录向上也解析不到 → 启动即崩（Cannot find package）。
 *
 * 本脚本把部署根的 @deepseek-ai/{dsh-tools,cordis} junction 链接进插件自己的
 * node_modules（learn-everything 同款方案），保证任何安装模式都能解析。
 * 部署根探测：DSH_DEPLOY_ROOT 环境变量 → Windows 常见路径 → 从插件位置推导。
 */
import { existsSync, mkdirSync, symlinkSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// 不含 @deepseek-ai 前缀的包名（src 已指向 .../node_modules/@deepseek-ai）
const NEEDED = ['dsh-tools', 'cordis']

function candidateRoots() {
  const out = []
  if (process.env.DSH_DEPLOY_ROOT) out.push(process.env.DSH_DEPLOY_ROOT)
  out.push('D:\\deepseek harness\\resources\\host')
  // 从插件位置向上推导：plugin-manager-src/github.com-xxx → 部署根可能在 D:\deepseek harness\resources\host
  const up = resolve(repo, '..', '..')
  if (/deepseek|harness/i.test(up)) {
    for (const guess of [
      join(up, 'resources', 'host'),
      join(up, 'host'),
      join(up, 'deepseek-harness', 'resources', 'host'),
    ]) {
      if (existsSync(join(guess, 'node_modules', '@deepseek-ai'))) out.push(guess)
    }
  }
  // ~/.dsh/profiles/*/node_modules
  const home = process.env.USERPROFILE || process.env.HOME || ''
  if (home) {
    const profiles = join(home, '.dsh', 'profiles')
    if (existsSync(profiles)) {
      for (const prof of readdirSync(profiles)) {
        out.push(join(profiles, prof))
      }
    }
  }
  return out
}

let src = null
for (const root of candidateRoots()) {
  const nm = join(root, 'node_modules', '@deepseek-ai')
  if (existsSync(join(nm, 'dsh-tools')) && existsSync(join(nm, 'cordis'))) {
    src = nm
    break
  }
}

if (!src) {
  console.error('[dsh-optimizer] 未找到 DSH 部署根 @deepseek-ai 包。请设置环境变量 DSH_DEPLOY_ROOT 指向部署根目录。')
  process.exit(1)
}

mkdirSync(join(repo, 'node_modules', '@deepseek-ai'), { recursive: true })
let linked = 0
for (const name of NEEDED) {
  const link = join(repo, 'node_modules', '@deepseek-ai', name)
  if (existsSync(link)) continue
  try {
    symlinkSync(join(src, name), link, 'junction')
    linked++
  } catch (e) {
    console.error(`[dsh-optimizer] 链接 ${name} 失败: ${e.message}`)
  }
}
console.log(`[dsh-optimizer] @deepseek-ai 链接完成（新增 ${linked} 个，来源: ${src}）`)
