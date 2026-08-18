/**
 * dsh-optimizer — DSH 会话性能优化插件
 *
 * 把这套优化方法打包成可直接使用的工具：
 *  1. optimizer_audit    会话体检：大小、事件规模、空会话、chunk 占比
 *  2. optimizer_archive  归档旧/大会话（移出 sessions 目录，可恢复）
 *  3. optimizer_cleanup  清理空会话（先列候选，确认后移入归档）
 *  4. optimizer_patch    history 分页补丁管理（assistant/chunk 不再拖慢会话切换）
 *
 * 背景：切换长会话卡顿的根因是流式 chunk 事件爆炸——一个大会话 13 万事件里
 * 99.4% 是 assistant/chunk，history 分页把这些 chunk 全部返回并逐个计算视图。
 * 补丁让 history 页跳过 chunk（tail 页从 ~2.7 万事件降到 ~200，约 130 倍）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { readdir, readFile, stat, mkdir, rename } from 'node:fs/promises'
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

// bundle 插件 host 半部没有 harness builtin（那是动态 Cordis 插件的沙箱注入）。
// 工具注册用 @deepseek-ai/dsh-tools 的 defineTool + ctx.tools.register（learn-everything
// 同款）；设置页 RPC 用 host 自建 webServer HTTP endpoint（prompt-enhancer 同款）。
// @deepseek-ai/* 的可解析性由 scripts/setup-dsh-links.mjs 提供（junction 链接部署根）。

export const name = 'dsh-optimizer'
export const inject = ['tools', 'webServer']

// ---------------------------------------------------------------------------
// 路径
// ---------------------------------------------------------------------------

const DSH_HOME = join(homedir(), '.dsh')
const SESSIONS_ROOT = join(DSH_HOME, 'sessions')
const ARCHIVE_ROOT = join(DSH_HOME, 'sessions-archive')

// ---------------------------------------------------------------------------
// 会话扫描
// ---------------------------------------------------------------------------

interface SessionInfo {
  id: string
  workspace: string
  dir: string
  logPath: string | null
  sizeBytes: number
  mtimeMs: number
  empty: boolean
}

async function scanSessions(root: string): Promise<SessionInfo[]> {
  const out: SessionInfo[] = []
  let workspaces: string[]
  try {
    workspaces = await readdir(root, { withFileTypes: true }).then(es =>
      es.filter(e => e.isDirectory()).map(e => e.name),
    )
  } catch {
    return out
  }
  for (const ws of workspaces) {
    const wsDir = join(root, ws)
    let sessionDirs: string[]
    try {
      sessionDirs = await readdir(wsDir, { withFileTypes: true }).then(es =>
        es.filter(e => e.isDirectory()).map(e => e.name),
      )
    } catch {
      continue
    }
    for (const id of sessionDirs) {
      const dir = join(wsDir, id)
      const zstd = join(dir, 'session.jsonl.zstd')
      const plain = join(dir, 'session.jsonl')
      const logPath = existsSync(zstd) ? zstd : existsSync(plain) ? plain : null
      let sizeBytes = 0
      let mtimeMs = 0
      let empty = true
      try {
        const st = await stat(dir)
        mtimeMs = st.mtimeMs
        if (logPath !== null) {
          const lst = await stat(logPath)
          sizeBytes = lst.size
          empty = sizeBytes === 0
        }
      } catch {
        // 无法 stat 的目录跳过
      }
      out.push({ id, workspace: ws, dir, logPath, sizeBytes, mtimeMs, empty })
    }
  }
  return out
}

function fmtMB(bytes: number): string {
  return `${(bytes / 1048576).toFixed(1)}MB`
}

function fmtDays(mtimeMs: number): string {
  const days = (Date.now() - mtimeMs) / 86400000
  return days < 1 ? `${Math.max(0, Math.floor(days * 24))}h` : `${Math.floor(days)}d`
}

// ---------------------------------------------------------------------------
// 补丁管理（history 滤 chunk）
// ---------------------------------------------------------------------------

const PATCH_START = '// dsh-optimizer:start'
const PATCH_END = '// dsh-optimizer:end'
const PATCH_BLOCK = `${PATCH_START}
const HISTORY_SKIPPED_TYPES = new Set(["assistant/chunk"]);
${PATCH_END}`
const PATCH_TARGET_LINE = `const MESSAGE_TYPES = new Set(["user/message", "assistant/message"]);`
const PAGINATE_FROM = `events: window.filter((event) => event.seq >= cut),`
// 补丁后的分页返回形态：滤 chunk + 补回窗口尾部边界事件（保客户端 loadOlder 连续性）
const PAGINATE_TO_HEAD = `events: window.filter((event) => event.seq >= cut && !HISTORY_SKIPPED_TYPES.has(event.type)).concat(`
// revert 用正则匹配跨行的补丁返回块（含 concat 边界补回逻辑）
const PAGINATE_PATCHED_RE = /events: window\.filter\(\(event\) => event\.seq >= cut && !HISTORY_SKIPPED_TYPES\.has\(event\.type\)\)\.concat\([\s\S]*?\n\s*\),/

/** 探测 dsh-host-apiproxy 部署文件（候选部署根列表，取第一个存在的）。 */
function findHostApiproxyIndex(): string | null {
  const candidates: string[] = []
  const env = process.env.DSH_DEPLOY_ROOT
  if (env) candidates.push(join(env, 'node_modules', '@deepseek-ai', 'dsh-host-apiproxy', 'lib', 'index.js'))
  // Windows 常见部署根
  candidates.push(
    join('D:\\', 'deepseek harness', 'resources', 'host', 'node_modules', '@deepseek-ai', 'dsh-host-apiproxy', 'lib', 'index.js'),
  )
  // profile node_modules（dshpm 安装布局）
  const profiles = join(DSH_HOME, 'profiles')
  if (existsSync(profiles)) {
    let profs: string[] = []
    try {
      profs = readdirSync(profiles)
    } catch {
      profs = []
    }
    for (const prof of profs) {
      candidates.push(join(profiles, prof, 'node_modules', '@deepseek-ai', 'dsh-host-apiproxy', 'lib', 'index.js'))
    }
  }
  return candidates.find(p => existsSync(p)) ?? null
}

interface PatchState {
  file: string | null
  patched: boolean
  details: string[]
}

function inspectPatch(file: string): PatchState {
  const src = readFileSync(file, 'utf8')
  const patched = src.includes(PATCH_START) || src.includes('HISTORY_SKIPPED_TYPES')
  const details: string[] = []
  if (!src.includes(PATCH_TARGET_LINE)) details.push('目标行 MESSAGE_TYPES 未找到，部署版本可能已变更')
  return { file, patched, details }
}

function applyPatch(file: string): PatchState {
  const src = readFileSync(file, 'utf8')
  if (src.includes(PATCH_START)) return { file, patched: true, details: ['补丁已存在'] }
  if (!src.includes(PATCH_TARGET_LINE)) return { file, patched: false, details: ['目标行 MESSAGE_TYPES 未找到，无法应用'] }
  if (!src.includes(PAGINATE_FROM)) return { file, patched: false, details: ['分页返回行未找到（可能已是补丁后的形态）'] }
  const withBlock = src.replace(PATCH_TARGET_LINE, PATCH_TARGET_LINE + '\n' + PATCH_BLOCK)
  const withFilter = withBlock.replace(PAGINATE_FROM, PAGINATE_TO_HEAD + `\n\t\t\tbeforeSeq === void 0 ? [] : (() => {\n\t\t\t\tconst boundary = window[window.length - 1];\n\t\t\t\treturn boundary !== void 0 && boundary.seq >= cut && HISTORY_SKIPPED_TYPES.has(boundary.type) ? [boundary] : [];\n\t\t\t})()\n\t\t),`)
  writeFileSync(file, withFilter, 'utf8')
  return { file, patched: true, details: ['已应用：history 页跳过 assistant/chunk（含边界保序）'] }
}

function revertPatch(file: string): PatchState {
  const src = readFileSync(file, 'utf8')
  if (!src.includes(PATCH_START) && !src.includes('HISTORY_SKIPPED_TYPES')) return { file, patched: false, details: ['未检测到补丁'] }
  let out = src
  // 恢复分页返回行（含跨行补丁块）
  out = out.replace(PAGINATE_PATCHED_RE, PAGINATE_FROM)
  // 移除补丁块
  const startIdx = out.indexOf(PATCH_START)
  if (startIdx >= 0) {
    const endIdx = out.indexOf(PATCH_END, startIdx)
    if (endIdx >= 0) {
      out = out.slice(0, startIdx) + out.slice(endIdx + PATCH_END.length)
    }
  }
  // 兜底：删除残留的常量定义行（兼容早期无标记补丁形态）
  out = out.split('\n').filter(line => line.trim() !== `const HISTORY_SKIPPED_TYPES = new Set(["assistant/chunk"]);`).join('\n')
  writeFileSync(file, out, 'utf8')
  return { file, patched: false, details: ['已回滚补丁'] }
}

// ---------------------------------------------------------------------------
// 工具渲染辅助
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 扫描与修复（设置页「一键优化」RPC 复用）
// ---------------------------------------------------------------------------

interface OptimizeIssue {
  id: string
  severity: 'high' | 'medium' | 'low'
  title: string
  detail: string
  fix: string
  count?: number
}

async function scanIssues(): Promise<{
  patch: { patched: boolean; file: string | null }
  stats: { total: number; totalMB: number; empty: number; chunkHeavy: number; oldLarge: number }
  issues: OptimizeIssue[]
}> {
  const sessions = await scanSessions(SESSIONS_ROOT)
  const totalMB = +(sessions.reduce((a, s) => a + s.sizeBytes, 0) / 1048576).toFixed(1)
  const empty = sessions.filter(s => s.empty)
  const chunkHeavy = sessions.filter(s => !s.empty && s.sizeBytes > 2 * 1048576)
  const oldLarge = sessions.filter(s => !s.empty && s.sizeBytes > 1048576 && s.mtimeMs < Date.now() - 7 * 86400000)
  const file = findHostApiproxyIndex()
  const patched = file !== null && (readFileSync(file, 'utf8').includes(PATCH_START) || readFileSync(file, 'utf8').includes('HISTORY_SKIPPED_TYPES'))
  const issues: OptimizeIssue[] = []
  if (!patched) {
    issues.push({
      id: 'patch-not-applied',
      severity: 'high',
      title: 'history 分页补丁未应用',
      detail: '长会话切换会携带全部流式 chunk（实测 50 条消息一页 2.7 万事件）。应用补丁后降到约 200 事件（130 倍），需重启 web 生效。',
      fix: 'apply_patch',
    })
  }
  if (empty.length > 0) {
    issues.push({
      id: 'empty-sessions',
      severity: 'medium',
      title: `${empty.length} 个空/损坏会话`,
      detail: `0 字节会话占用列表条目，无数据可恢复。移入 ${ARCHIVE_ROOT} 可恢复但无实际意义。`,
      fix: 'cleanup_empty',
      count: empty.length,
    })
  }
  if (chunkHeavy.length > 0) {
    issues.push({
      id: 'chunk-heavy-sessions',
      severity: 'medium',
      title: `${chunkHeavy.length} 个大会话（>2MB，通常 99% 是流式 chunk）`,
      detail: `最大 ${chunkHeavy[0] ? fmtMB(chunkHeavy[0].sizeBytes) : ''}。切到这些会话最慢；补丁已缓解，进一步可归档不再活跃的。`,
      fix: 'none',
      count: chunkHeavy.length,
    })
  }
  if (oldLarge.length > 0) {
    issues.push({
      id: 'old-large-sessions',
      severity: 'low',
      title: `${oldLarge.length} 个旧大会话可归档`,
      detail: '超过 7 天未动且大于 1MB 的会话，归档后列表与切换更快（移入 sessions-archive，可恢复）。',
      fix: 'archive_old',
      count: oldLarge.length,
    })
  }
  if (issues.length === 0) {
    issues.push({ id: 'all-good', severity: 'low', title: '没有发现可优化问题', detail: '补丁已应用，会话健康。', fix: 'none' })
  }
  return {
    patch: { patched, file },
    stats: { total: sessions.length, totalMB, empty: empty.length, chunkHeavy: chunkHeavy.length, oldLarge: oldLarge.length },
    issues,
  }
}

async function applyFix(fix: string): Promise<{ ok: boolean; message: string }> {
  switch (fix) {
    case 'apply_patch': {
      const file = findHostApiproxyIndex()
      if (file === null) return { ok: false, message: '未找到 dsh-host-apiproxy 部署文件' }
      const r = applyPatch(file)
      return { ok: r.patched, message: r.details.join('；') + (r.patched ? '。重启 dsh web 后生效。' : '') }
    }
    case 'cleanup_empty': {
      const sessions = await scanSessions(SESSIONS_ROOT)
      const empty = sessions.filter(s => s.empty)
      let moved = 0
      for (const s of empty) {
        try {
          const destWs = join(ARCHIVE_ROOT, s.workspace)
          await mkdir(destWs, { recursive: true })
          await rename(s.dir, join(destWs, s.id))
          moved++
        } catch { /* 单个失败跳过 */ }
      }
      return { ok: true, message: `已移入归档 ${moved}/${empty.length} 个空会话` }
    }
    case 'archive_old': {
      const sessions = await scanSessions(SESSIONS_ROOT)
      const targets = sessions.filter(s => !s.empty && s.sizeBytes > 1048576 && s.mtimeMs < Date.now() - 7 * 86400000)
      let moved = 0
      for (const s of targets) {
        try {
          const destWs = join(ARCHIVE_ROOT, s.workspace)
          await mkdir(destWs, { recursive: true })
          await rename(s.dir, join(destWs, s.id))
          moved++
        } catch { /* 单个失败跳过 */ }
      }
      return { ok: true, message: `已归档 ${moved}/${targets.length} 个旧大会话（可恢复）` }
    }
    default:
      return { ok: false, message: `未知修复类型: ${fix}` }
  }
}

// ---------------------------------------------------------------------------
// 插件主体
// ---------------------------------------------------------------------------

export function apply(ctx: Context): void {
  // ---- 设置页「一键优化」RPC（host 自建 HTTP endpoint，bundle 插件无 harness）----
  const rpcHandlers: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
    'optimizer/scan': async () => {
      try {
        return { ok: true, ...(await scanIssues()) }
      } catch (e) {
        return { ok: false, message: String(e) }
      }
    },
    'optimizer/apply': async (args) => {
      const fix = typeof args?.fix === 'string' ? args.fix : ''
      if (!fix) return { ok: false, message: '缺少 fix 参数' }
      try {
        return await applyFix(fix)
      } catch (e) {
        return { ok: false, message: String(e) }
      }
    },
  }
  const webServer = ctx.get('webServer') as
    | { register: (opts: { kind: string; path: string; handler: (req: unknown, res: unknown) => void | Promise<void> }) => unknown }
    | undefined
  if (webServer !== undefined && typeof webServer.register === 'function') {
    webServer.register({
      kind: 'exact',
      path: '/dsh-optimizer/rpc',
      handler: async (req: unknown, res: unknown) => {
        const request = req as { method?: string; on?: (ev: string, cb: (chunk: string) => void) => void }
        const response = res as { writeHead: (code: number, headers?: Record<string, string>) => void; end: (body: string) => void }
        if (request?.method !== 'POST') {
          response.writeHead(405, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ ok: false, code: 'METHOD_NOT_ALLOWED' }))
          return
        }
        let body = ''
        const on = request.on
        if (typeof on === 'function') {
          await new Promise<void>((resolve) => {
            let settled = false
            const finish = () => { if (!settled) { settled = true; resolve() } }
            on('data', (chunk: string) => { body += chunk })
            on('end', finish)
            on('error', finish)
          })
        }
        let method = ''
        let args: Record<string, unknown> = {}
        try {
          const parsed = JSON.parse(body || '{}')
          method = typeof parsed.method === 'string' ? parsed.method : ''
          args = typeof parsed.args === 'object' && parsed.args !== null ? parsed.args : {}
        } catch {
          response.writeHead(400, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ ok: false, code: 'BAD_JSON' }))
          return
        }
        const fn = rpcHandlers[method]
        if (!fn) {
          response.writeHead(404, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ ok: false, code: 'UNKNOWN_METHOD', method }))
          return
        }
        try {
          const result = await fn(args)
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify(result))
        } catch (e) {
          response.writeHead(500, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ ok: false, message: String(e) }))
        }
      },
    })
  }

  // ---- optimizer_audit: 会话体检 ----
  ctx.tools.register(defineTool({
    name: 'optimizer_audit',
    description: '扫描 DSH 会话目录，报告会话总数、总大小、空会话数、以及最大的 N 个会话（含事件规模与流式 chunk 占比），用于定位拖慢会话切换的大会话。',
    parameters: {
      limit: { type: 'number', description: '列出最大的几个会话，默认 15' },
      minMB: { type: 'number', description: '只列出大小不低于该 MB 的会话，默认 0.1' },
      full: { type: 'string', description: 'full=true 时解压统计每个大会话的事件数/chunk 占比（慢），否则只按文件大小排序' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
        },
      },
      render: (_args: unknown, value: { text: string }) => [{ type: 'text', text: value.text }],
    },
    async execute(args: { limit?: number; minMB?: number; full?: string }) {
      const limit = args.limit ?? 15
      const minBytes = (args.minMB ?? 0.1) * 1048576
      const full = String(args.full ?? 'false') === 'true'
      const sessions = await scanSessions(SESSIONS_ROOT)
      const totalBytes = sessions.reduce((a, s) => a + s.sizeBytes, 0)
      const empty = sessions.filter(s => s.empty)
      const big = sessions
        .filter(s => !s.empty && s.sizeBytes >= minBytes)
        .sort((a, b) => b.sizeBytes - a.sizeBytes)
        .slice(0, limit)
      const lines: string[] = []
      lines.push(`会话总数: ${sessions.length} | 磁盘占用: ${fmtMB(totalBytes)} | 空会话: ${empty.length}`)
      lines.push(`大会话(≥${fmtMB(minBytes)}): ${big.length} 个，Top ${Math.min(big.length, limit)}：`)
      for (const s of big) {
        let extra = ''
        if (full && s.logPath !== null) {
          try {
            extra = await chunkStats(s.logPath)
          } catch {
            extra = ' (统计失败)'
          }
        }
        lines.push(`  ${s.id}  ${fmtMB(s.sizeBytes)}  最后活动 ${fmtDays(s.mtimeMs)}  ${s.workspace}${extra}`)
      }
      if (full) lines.push('提示: chunk 占比 >95% 的会话是切换卡顿的主要来源，可归档或由 optimizer_patch 补丁缓解。')
      return { text: lines.join('\n') }
    },
  }))

  // ---- optimizer_archive: 归档旧/大会话 ----
  ctx.tools.register(defineTool({
    name: 'optimizer_archive',
    description: '把不再活跃的大会话（超过 N 天未动且超过 X MB）从 ~/.dsh/sessions 移到 ~/.dsh/sessions-archive/，DSH 不再加载它们，会话列表与切换速度立刻变快。归档可恢复（手动移回原工作区目录即可）。',
    parameters: {
      olderThanDays: { type: 'number', description: '超过该天数未动的会话才归档，默认 7' },
      minMB: { type: 'number', description: '只归档大小不低于该 MB 的会话，默认 1' },
      ids: { type: 'string', description: '可选：明确指定要归档的 sessionId（逗号分隔），忽略其他条件' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
        },
      },
      render: (_args: unknown, value: { text: string }) => [{ type: 'text', text: value.text }],
    },
    async execute(args: { olderThanDays?: number; minMB?: number; ids?: string }) {
      const olderDays = args.olderThanDays ?? 7
      const minBytes = (args.minMB ?? 1) * 1048576
      const idSet = args.ids ? new Set(args.ids.split(',').map(x => x.trim()).filter(Boolean)) : null
      const cutoff = Date.now() - olderDays * 86400000
      const sessions = await scanSessions(SESSIONS_ROOT)
      const targets = sessions.filter(s =>
        idSet ? idSet.has(s.id) : (!s.empty && s.sizeBytes >= minBytes && s.mtimeMs < cutoff),
      )
      const lines: string[] = []
      let moved = 0
      for (const s of targets) {
        const destWs = join(ARCHIVE_ROOT, s.workspace)
        const dest = join(destWs, s.id)
        try {
          await mkdir(destWs, { recursive: true })
          await rename(s.dir, dest)
          moved++
          lines.push(`  归档: ${s.id} (${fmtMB(s.sizeBytes)}, 最后活动 ${fmtDays(s.mtimeMs)})`)
        } catch (e) {
          lines.push(`  失败: ${s.id} — ${String(e)}`)
        }
      }
      lines.unshift(`已归档 ${moved} 个会话到 ${ARCHIVE_ROOT}。` + (moved === 0 ? '没有符合条件的会话。' : ''))
      if (idSet) lines.push('提示: 归档仅移动目录，可在文件管理器中从 sessions-archive 手动移回恢复。')
      return { text: lines.join('\n') }
    },
  }))

  // ---- optimizer_cleanup: 清理空会话 ----
  ctx.tools.register(defineTool({
    name: 'optimizer_cleanup',
    description: '扫描并处理空/损坏的会话（0 字节或无日志文件）。默认 dryRun=true 只列出候选；dryRun=false 时把候选移入 sessions-archive（可恢复，不直接删除）。',
    parameters: {
      dryRun: { type: 'string', description: 'dryRun=false 时实际执行移入归档；缺省/其他值为只列候选' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
        },
      },
      render: (_args: unknown, value: { text: string }) => [{ type: 'text', text: value.text }],
    },
    async execute(args: { dryRun?: string }) {
      const doMove = String(args.dryRun ?? '') === 'false'
      const sessions = await scanSessions(SESSIONS_ROOT)
      const empty = sessions.filter(s => s.empty)
      const lines: string[] = []
      if (empty.length === 0) {
        lines.push('没有空会话。')
        return { text: lines.join('\n') }
      }
      lines.push(`发现 ${empty.length} 个空会话${doMove ? '，移入归档：' : '（dryRun，未移动）：'}`)
      let moved = 0
      for (const s of empty) {
        if (doMove) {
          try {
            const destWs = join(ARCHIVE_ROOT, s.workspace)
            await mkdir(destWs, { recursive: true })
            await rename(s.dir, join(destWs, s.id))
            moved++
          } catch (e) {
            lines.push(`  失败: ${s.id} — ${String(e)}`)
            continue
          }
        }
        lines.push(`  ${s.id}  ${s.workspace}`)
      }
      if (doMove) lines.push(`已移入归档 ${moved} 个。`)
      else lines.push('确认无误后，用 dryRun=false 再执行一次。')
      return { text: lines.join('\n') }
    },
  }))

  // ---- optimizer_patch: 补丁管理 ----
  ctx.tools.register(defineTool({
    name: 'optimizer_patch',
    description: '管理「history 分页跳过流式 chunk」补丁（针对部署的 dsh-host-apiproxy）：status 检查，apply 应用（幂等，滤 chunk 且补回边界事件保证分页连续性），revert 回滚。补丁让长会话切换从数秒降到亚秒级。',
    parameters: {
      action: { type: 'string', description: 'status | apply | revert，默认 status', required: true },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
        },
      },
      render: (_args: unknown, value: { text: string }) => [{ type: 'text', text: value.text }],
    },
    async execute(args: { action?: string }) {
      const action = args.action ?? 'status'
      const file = findHostApiproxyIndex()
      if (file === null) {
        return { text: '未找到 dsh-host-apiproxy 部署文件。可用环境变量 DSH_DEPLOY_ROOT 指定部署根，或手动修改 node_modules/@deepseek-ai/dsh-host-apiproxy/lib/index.js。' }
      }
      const lines: string[] = [`目标: ${file}`]
      try {
        if (action === 'apply') {
          const r = applyPatch(file)
          lines.push(r.patched ? `✓ 已应用补丁：${r.details.join('；')}` : `✗ 未应用：${r.details.join('；')}`)
          lines.push('提示: 补丁为部署文件修改，需重启 dsh web 进程生效；升级 DSH 后需重新应用。')
        } else if (action === 'revert') {
          const r = revertPatch(file)
          lines.push(!r.patched ? `✓ 已回滚：${r.details.join('；')}` : `✗ ${r.details.join('；')}`)
        } else {
          const r = inspectPatch(file)
          lines.push(r.patched ? '✓ 补丁状态: 已应用（history 页跳过 assistant/chunk，含边界保序）' : '✗ 补丁状态: 未应用')
          if (r.details.length) lines.push(...r.details.map(d => `  - ${d}`))
          lines.push('操作: action=apply 应用，action=revert 回滚。')
        }
      } catch (e) {
        lines.push(`操作失败: ${String(e)}`)
      }
      return { text: lines.join('\n') }
    },
  }))
}

// ---------------------------------------------------------------------------
// chunk 占比统计（full audit 用）
// ---------------------------------------------------------------------------

async function chunkStats(logPath: string): Promise<string> {
  const buf = await readFile(logPath)
  const frames = scanZstdFrames(buf)
  const parts: Buffer[] = []
  for (const { start, end } of frames) {
    parts.push(Buffer.from(zstdDecompressSync(buf.subarray(start, end))))
  }
  const text = Buffer.concat(parts).toString('utf8')
  let events = 0
  let chunks = 0
  for (const line of text.split('\n')) {
    const s = line.trim()
    if (!s) continue
    events++
    // chunk 行：独立 assistant/chunk 行或打包行（text-chunks / reasoning-chunks / tool-call-chunks）
    if (
      s.includes('"assistant/chunk"') ||
      s.includes('"type": "text-chunks"') ||
      s.includes('"type":"text-chunks"') ||
      s.includes('"type": "reasoning-chunks"') ||
      s.includes('"type":"reasoning-chunks"') ||
      s.includes('"type": "tool-call-chunks"') ||
      s.includes('"type":"tool-call-chunks"')
    ) {
      chunks++
    }
  }
  const ratio = events > 0 ? Math.round((chunks / events) * 100) : 0
  return `  事件行≈${events} chunk行占比${ratio}%`
}

const ZSTD_MAGIC = 4247762216

function scanZstdFrames(buffer: Buffer): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = []
  let o = 0
  while (o < buffer.length) {
    const s = o
    if (buffer.length - o < 4) return out
    if (buffer.readUInt32LE(o) !== ZSTD_MAGIC) return out
    o += 4
    if (o === buffer.length) return out
    const d = buffer.readUInt8(o)
    o += 1
    if ((d & 24) !== 0) return out
    const cf = d >>> 6
    const sg = (d & 32) !== 0
    const ck = (d & 4) !== 0
    const df = d & 3
    const db = df === 3 ? 4 : df
    const cb = cf === 0 ? (sg ? 1 : 0) : 1 << cf
    const rh = (sg ? 0 : 1) + db + cb
    if (buffer.length - o < rh) return out
    o += rh
    for (;;) {
      if (buffer.length - o < 3) return out
      const bh = buffer.readUIntLE(o, 3)
      o += 3
      const lb = (bh & 1) !== 0
      const bt = (bh >>> 1) & 3
      const bs = bh >>> 3
      if (bt === 3) return out
      const pb = bt === 1 ? 1 : bs
      if (buffer.length - o < pb) return out
      o += pb
      if (lb) break
    }
    if (ck) {
      if (buffer.length - o < 4) return out
      o += 4
    }
    out.push({ start: s, end: o })
  }
  return out
}
