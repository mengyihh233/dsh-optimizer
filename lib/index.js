import { defineTool } from '@deepseek-ai/dsh-tools';
import { readdir, readFile, stat, mkdir, rename } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { zstdDecompressSync } from 'node:zlib';
export const name = 'dsh-optimizer';
export const inject = ['tools'];
// ---------------------------------------------------------------------------
// 路径
// ---------------------------------------------------------------------------
const DSH_HOME = join(homedir(), '.dsh');
const SESSIONS_ROOT = join(DSH_HOME, 'sessions');
const ARCHIVE_ROOT = join(DSH_HOME, 'sessions-archive');
async function scanSessions(root) {
    const out = [];
    let workspaces;
    try {
        workspaces = await readdir(root, { withFileTypes: true }).then(es => es.filter(e => e.isDirectory()).map(e => e.name));
    }
    catch {
        return out;
    }
    for (const ws of workspaces) {
        const wsDir = join(root, ws);
        let sessionDirs;
        try {
            sessionDirs = await readdir(wsDir, { withFileTypes: true }).then(es => es.filter(e => e.isDirectory()).map(e => e.name));
        }
        catch {
            continue;
        }
        for (const id of sessionDirs) {
            const dir = join(wsDir, id);
            const zstd = join(dir, 'session.jsonl.zstd');
            const plain = join(dir, 'session.jsonl');
            const logPath = existsSync(zstd) ? zstd : existsSync(plain) ? plain : null;
            let sizeBytes = 0;
            let mtimeMs = 0;
            let empty = true;
            try {
                const st = await stat(dir);
                mtimeMs = st.mtimeMs;
                if (logPath !== null) {
                    const lst = await stat(logPath);
                    sizeBytes = lst.size;
                    empty = sizeBytes === 0;
                }
            }
            catch {
                // 无法 stat 的目录跳过
            }
            out.push({ id, workspace: ws, dir, logPath, sizeBytes, mtimeMs, empty });
        }
    }
    return out;
}
function fmtMB(bytes) {
    return `${(bytes / 1048576).toFixed(1)}MB`;
}
function fmtDays(mtimeMs) {
    const days = (Date.now() - mtimeMs) / 86400000;
    return days < 1 ? `${Math.max(0, Math.floor(days * 24))}h` : `${Math.floor(days)}d`;
}
// ---------------------------------------------------------------------------
// 补丁管理（history 滤 chunk）
// ---------------------------------------------------------------------------
const PATCH_START = '// dsh-optimizer:start';
const PATCH_END = '// dsh-optimizer:end';
const PATCH_BLOCK = `${PATCH_START}
const HISTORY_SKIPPED_TYPES = new Set(["assistant/chunk"]);
${PATCH_END}`;
const PATCH_TARGET_LINE = `const MESSAGE_TYPES = new Set(["user/message", "assistant/message"]);`;
const PAGINATE_FROM = `events: window.filter((event) => event.seq >= cut)`;
const PAGINATE_TO = `events: window.filter((event) => event.seq >= cut && !HISTORY_SKIPPED_TYPES.has(event.type))`;
/** 探测 dsh-host-apiproxy 部署文件（候选部署根列表，取第一个存在的）。 */
function findHostApiproxyIndex() {
    const candidates = [];
    const env = process.env.DSH_DEPLOY_ROOT;
    if (env)
        candidates.push(join(env, 'node_modules', '@deepseek-ai', 'dsh-host-apiproxy', 'lib', 'index.js'));
    // Windows 常见部署根
    candidates.push(join('D:\\', 'deepseek harness', 'resources', 'host', 'node_modules', '@deepseek-ai', 'dsh-host-apiproxy', 'lib', 'index.js'));
    // profile node_modules（dshpm 安装布局）
    const profiles = join(DSH_HOME, 'profiles');
    if (existsSync(profiles)) {
        let profs = [];
        try {
            profs = readdirSync(profiles);
        }
        catch {
            profs = [];
        }
        for (const prof of profs) {
            candidates.push(join(profiles, prof, 'node_modules', '@deepseek-ai', 'dsh-host-apiproxy', 'lib', 'index.js'));
        }
    }
    return candidates.find(p => existsSync(p)) ?? null;
}
function inspectPatch(file) {
    const src = readFileSync(file, 'utf8');
    const patched = src.includes(PATCH_START) || src.includes('HISTORY_SKIPPED_TYPES');
    const details = [];
    if (!src.includes(PATCH_TARGET_LINE))
        details.push('目标行 MESSAGE_TYPES 未找到，部署版本可能已变更');
    if (!src.includes(PAGINATE_FROM) && !src.includes(PAGINATE_TO))
        details.push('分页返回行未找到，部署版本可能已变更');
    return { file, patched, details };
}
function applyPatch(file) {
    const src = readFileSync(file, 'utf8');
    if (src.includes(PATCH_START))
        return { file, patched: true, details: ['补丁已存在'] };
    if (!src.includes(PATCH_TARGET_LINE))
        return { file, patched: false, details: ['目标行 MESSAGE_TYPES 未找到，无法应用'] };
    if (!src.includes(PAGINATE_FROM))
        return { file, patched: false, details: ['分页返回行未找到（可能已是补丁后的形态）'] };
    const withBlock = src.replace(PATCH_TARGET_LINE, PATCH_TARGET_LINE + '\n' + PATCH_BLOCK);
    const withFilter = withBlock.replace(PAGINATE_FROM, PAGINATE_TO);
    writeFileSync(file, withFilter, 'utf8');
    return { file, patched: true, details: ['已应用：history 页跳过 assistant/chunk 事件'] };
}
function revertPatch(file) {
    const src = readFileSync(file, 'utf8');
    if (!src.includes(PATCH_START) && !src.includes(PAGINATE_TO))
        return { file, patched: false, details: ['未检测到补丁'] };
    let out = src;
    // 移除补丁块
    const startIdx = out.indexOf(PATCH_START);
    if (startIdx >= 0) {
        const endIdx = out.indexOf(PATCH_END, startIdx);
        if (endIdx >= 0) {
            out = out.slice(0, startIdx) + out.slice(endIdx + PATCH_END.length);
        }
    }
    out = out.split(PAGINATE_TO).join(PAGINATE_FROM);
    writeFileSync(file, out, 'utf8');
    return { file, patched: false, details: ['已回滚补丁'] };
}
// ---------------------------------------------------------------------------
// 工具渲染辅助
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 插件主体
// ---------------------------------------------------------------------------
export function apply(ctx) {
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
            render: (_args, value) => [{ type: 'text', text: value.text }],
        },
        async execute(args) {
            const limit = args.limit ?? 15;
            const minBytes = (args.minMB ?? 0.1) * 1048576;
            const full = String(args.full ?? 'false') === 'true';
            const sessions = await scanSessions(SESSIONS_ROOT);
            const totalBytes = sessions.reduce((a, s) => a + s.sizeBytes, 0);
            const empty = sessions.filter(s => s.empty);
            const big = sessions
                .filter(s => !s.empty && s.sizeBytes >= minBytes)
                .sort((a, b) => b.sizeBytes - a.sizeBytes)
                .slice(0, limit);
            const lines = [];
            lines.push(`会话总数: ${sessions.length} | 磁盘占用: ${fmtMB(totalBytes)} | 空会话: ${empty.length}`);
            lines.push(`大会话(≥${fmtMB(minBytes)}): ${big.length} 个，Top ${Math.min(big.length, limit)}：`);
            for (const s of big) {
                let extra = '';
                if (full && s.logPath !== null) {
                    try {
                        extra = await chunkStats(s.logPath);
                    }
                    catch {
                        extra = ' (统计失败)';
                    }
                }
                lines.push(`  ${s.id}  ${fmtMB(s.sizeBytes)}  最后活动 ${fmtDays(s.mtimeMs)}  ${s.workspace}${extra}`);
            }
            if (full)
                lines.push('提示: chunk 占比 >95% 的会话是切换卡顿的主要来源，可归档或由 optimizer_patch 补丁缓解。');
            return { text: lines.join('\n') };
        },
    }));
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
            render: (_args, value) => [{ type: 'text', text: value.text }],
        },
        async execute(args) {
            const olderDays = args.olderThanDays ?? 7;
            const minBytes = (args.minMB ?? 1) * 1048576;
            const idSet = args.ids ? new Set(args.ids.split(',').map(x => x.trim()).filter(Boolean)) : null;
            const cutoff = Date.now() - olderDays * 86400000;
            const sessions = await scanSessions(SESSIONS_ROOT);
            const targets = sessions.filter(s => idSet ? idSet.has(s.id) : (!s.empty && s.sizeBytes >= minBytes && s.mtimeMs < cutoff));
            const lines = [];
            let moved = 0;
            for (const s of targets) {
                const destWs = join(ARCHIVE_ROOT, s.workspace);
                const dest = join(destWs, s.id);
                try {
                    await mkdir(destWs, { recursive: true });
                    await rename(s.dir, dest);
                    moved++;
                    lines.push(`  归档: ${s.id} (${fmtMB(s.sizeBytes)}, 最后活动 ${fmtDays(s.mtimeMs)})`);
                }
                catch (e) {
                    lines.push(`  失败: ${s.id} — ${String(e)}`);
                }
            }
            lines.unshift(`已归档 ${moved} 个会话到 ${ARCHIVE_ROOT}。` + (moved === 0 ? '没有符合条件的会话。' : ''));
            if (idSet)
                lines.push('提示: 归档仅移动目录，可在文件管理器中从 sessions-archive 手动移回恢复。');
            return { text: lines.join('\n') };
        },
    }));
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
            render: (_args, value) => [{ type: 'text', text: value.text }],
        },
        async execute(args) {
            const doMove = String(args.dryRun ?? '') === 'false';
            const sessions = await scanSessions(SESSIONS_ROOT);
            const empty = sessions.filter(s => s.empty);
            const lines = [];
            if (empty.length === 0) {
                lines.push('没有空会话。');
                return { text: lines.join('\n') };
            }
            lines.push(`发现 ${empty.length} 个空会话${doMove ? '，移入归档：' : '（dryRun，未移动）：'}`);
            let moved = 0;
            for (const s of empty) {
                if (doMove) {
                    try {
                        const destWs = join(ARCHIVE_ROOT, s.workspace);
                        await mkdir(destWs, { recursive: true });
                        await rename(s.dir, join(destWs, s.id));
                        moved++;
                    }
                    catch (e) {
                        lines.push(`  失败: ${s.id} — ${String(e)}`);
                        continue;
                    }
                }
                lines.push(`  ${s.id}  ${s.workspace}`);
            }
            if (doMove)
                lines.push(`已移入归档 ${moved} 个。`);
            else
                lines.push('确认无误后，用 dryRun=false 再执行一次。');
            return { text: lines.join('\n') };
        },
    }));
    // ---- optimizer_patch: 补丁管理 ----
    ctx.tools.register(defineTool({
        name: 'optimizer_patch',
        description: '管理「history 分页跳过流式 chunk」补丁（针对部署的 dsh-host-apiproxy）：status 检查是否已打补丁，apply 应用补丁（幂等），revert 回滚。补丁让长会话切换从数秒降到亚秒级。',
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
            render: (_args, value) => [{ type: 'text', text: value.text }],
        },
        async execute(args) {
            const action = args.action ?? 'status';
            const file = findHostApiproxyIndex();
            if (file === null) {
                return { text: '未找到 dsh-host-apiproxy 部署文件。可用环境变量 DSH_DEPLOY_ROOT 指定部署根，或手动修改 node_modules/@deepseek-ai/dsh-host-apiproxy/lib/index.js。' };
            }
            const lines = [`目标: ${file}`];
            try {
                if (action === 'apply') {
                    const r = applyPatch(file);
                    lines.push(r.patched ? `✓ 已应用补丁：${r.details.join('；')}` : `✗ 未应用：${r.details.join('；')}`);
                    lines.push('提示: 补丁为部署文件修改，需重启 dsh web 进程生效；升级 DSH 后需重新应用。');
                }
                else if (action === 'revert') {
                    const r = revertPatch(file);
                    lines.push(!r.patched ? `✓ 已回滚：${r.details.join('；')}` : `✗ ${r.details.join('；')}`);
                }
                else {
                    const r = inspectPatch(file);
                    lines.push(r.patched ? '✓ 补丁状态: 已应用（history 页跳过 assistant/chunk）' : '✗ 补丁状态: 未应用');
                    if (r.details.length)
                        lines.push(...r.details.map(d => `  - ${d}`));
                    lines.push('操作: action=apply 应用，action=revert 回滚。');
                }
            }
            catch (e) {
                lines.push(`操作失败: ${String(e)}`);
            }
            return { text: lines.join('\n') };
        },
    }));
}
// ---------------------------------------------------------------------------
// chunk 占比统计（full audit 用）
// ---------------------------------------------------------------------------
async function chunkStats(logPath) {
    const buf = await readFile(logPath);
    const frames = scanZstdFrames(buf);
    const parts = [];
    for (const { start, end } of frames) {
        parts.push(Buffer.from(zstdDecompressSync(buf.subarray(start, end))));
    }
    const text = Buffer.concat(parts).toString('utf8');
    let events = 0;
    let chunks = 0;
    for (const line of text.split('\n')) {
        const s = line.trim();
        if (!s)
            continue;
        events++;
        // chunk 行：独立 assistant/chunk 行或打包行（text-chunks / reasoning-chunks / tool-call-chunks）
        if (s.includes('"assistant/chunk"') ||
            s.includes('"type": "text-chunks"') ||
            s.includes('"type":"text-chunks"') ||
            s.includes('"type": "reasoning-chunks"') ||
            s.includes('"type":"reasoning-chunks"') ||
            s.includes('"type": "tool-call-chunks"') ||
            s.includes('"type":"tool-call-chunks"')) {
            chunks++;
        }
    }
    const ratio = events > 0 ? Math.round((chunks / events) * 100) : 0;
    return `  事件行≈${events} chunk行占比${ratio}%`;
}
const ZSTD_MAGIC = 4247762216;
function scanZstdFrames(buffer) {
    const out = [];
    let o = 0;
    while (o < buffer.length) {
        const s = o;
        if (buffer.length - o < 4)
            return out;
        if (buffer.readUInt32LE(o) !== ZSTD_MAGIC)
            return out;
        o += 4;
        if (o === buffer.length)
            return out;
        const d = buffer.readUInt8(o);
        o += 1;
        if ((d & 24) !== 0)
            return out;
        const cf = d >>> 6;
        const sg = (d & 32) !== 0;
        const ck = (d & 4) !== 0;
        const df = d & 3;
        const db = df === 3 ? 4 : df;
        const cb = cf === 0 ? (sg ? 1 : 0) : 1 << cf;
        const rh = (sg ? 0 : 1) + db + cb;
        if (buffer.length - o < rh)
            return out;
        o += rh;
        for (;;) {
            if (buffer.length - o < 3)
                return out;
            const bh = buffer.readUIntLE(o, 3);
            o += 3;
            const lb = (bh & 1) !== 0;
            const bt = (bh >>> 1) & 3;
            const bs = bh >>> 3;
            if (bt === 3)
                return out;
            const pb = bt === 1 ? 1 : bs;
            if (buffer.length - o < pb)
                return out;
            o += pb;
            if (lb)
                break;
        }
        if (ck) {
            if (buffer.length - o < 4)
                return out;
            o += 4;
        }
        out.push({ start: s, end: o });
    }
    return out;
}
