/**
 * dsh-optimizer client — 设置页「优化」面板
 * 一键扫描 → 列出可优化问题 → 逐项修复 / 一键优化全部。
 * 通过 host.call 与 host 半部通信（optimizer/scan, optimizer/apply）。
 */

// client 运行时全局（bundle 插件 builtin）——TS 类型声明
declare const React: {
  createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => unknown
  useState: <T>(initial: T) => [T, (v: T | ((p: T) => T)) => void]
  useEffect: (effect: () => void | (() => void), deps?: unknown[]) => void
  useCallback: <T extends (...args: never[]) => unknown>(fn: T, deps: unknown[]) => T
  useMemo: <T>(fn: () => T, deps: unknown[]) => T
}
declare const host: { call: (method: string, args?: Record<string, unknown>) => Promise<unknown> }
declare const styles: { insert: (css: string) => () => void }

import type { Context } from '@deepseek-ai/cordis'


export const name = 'dsh-optimizer'
export const inject = ['slots']

interface Issue {
  id: string
  severity: 'high' | 'medium' | 'low'
  title: string
  detail: string
  fix: string
  count?: number
}

interface ScanResult {
  ok: boolean
  patch?: { patched: boolean; file: string | null }
  stats?: { total: number; totalMB: number; empty: number; chunkHeavy: number; oldLarge: number }
  issues?: Issue[]
  message?: string
}

const CSS = `
.dsh-opt-root{display:flex;flex-direction:column;gap:16px;padding:4px 0}
.dsh-opt-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-interactive-bg-hover);border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:8px}
.dsh-opt-card h3{margin:0;font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dsh-opt-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px}
.dsh-opt-stat{background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px 10px;display:flex;flex-direction:column;gap:2px}
.dsh-opt-stat b{font-size:18px;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
.dsh-opt-stat span{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dsh-opt-row{display:flex;align-items:center;justify-content:space-between;gap:10px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:10px 12px}
.dsh-opt-row-main{display:flex;flex-direction:column;gap:2px;min-width:0}
.dsh-opt-row-title{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary);display:flex;align-items:center;gap:6px}
.dsh-opt-row-detail{font-size:12px;color:var(--dsw-alias-label-tertiary);line-height:18px;word-break:break-all}
.dsh-opt-badge{font-size:11px;line-height:16px;padding:0 6px;border-radius:10px;flex:none}
.dsh-opt-badge-high{background:var(--dsw-alias-state-error-tertiary);color:var(--dsw-alias-state-error-primary)}
.dsh-opt-badge-medium{background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-warn-primary)}
.dsh-opt-badge-low{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dsh-opt-btn{border:none;border-radius:8px;padding:6px 12px;font-size:12px;font-weight:500;cursor:pointer;flex:none;color:var(--dsw-alias-label-primary-bluish);background:var(--dsw-alias-state-business-tertiary)}
.dsh-opt-btn:hover:not(:disabled){filter:brightness(1.1)}
.dsh-opt-btn:disabled{opacity:.5;cursor:default}
.dsh-opt-btn-primary{background:var(--dsw-static-deepseek-500,#4d6bfe);color:#fff}
.dsh-opt-btn-ghost{background:transparent;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.dsh-opt-log{font-family:var(--ds-font-family-code,monospace);font-size:11px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px 10px;max-height:120px;overflow:auto;white-space:pre-wrap;word-break:break-all}
.dsh-opt-ok{color:var(--dsw-alias-state-success-primary)}
.dsh-opt-err{color:var(--dsw-alias-state-error-primary)}
.dsh-opt-empty{color:var(--dsw-alias-label-tertiary);font-size:12px;padding:8px 0}
`

function severityLabel(s: string): string {
  return s === 'high' ? '高' : s === 'medium' ? '中' : '低'
}

function OptimizerSettings(props: { close: () => void }) {
  const [scan, setScan] = React.useState<ScanResult | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [log, setLog] = React.useState<string[]>([])
  const [applying, setApplying] = React.useState<string | null>(null)

  const pushLog = (line: string) => setLog(prev => [...prev.slice(-19), line])

  const runScan = React.useCallback(async () => {
    setLoading(true)
    try {
      const r = (await host.call('optimizer/scan')) as ScanResult
      setScan(r)
      if (!r.ok) pushLog('扫描失败: ' + (r.message ?? '未知错误'))
      else pushLog(`扫描完成：${r.stats?.total ?? 0} 会话 / ${r.stats?.totalMB ?? 0}MB，发现 ${r.issues?.length ?? 0} 项`)
    } catch (e) {
      pushLog('扫描异常: ' + String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    runScan()
  }, [runScan])

  const doFix = React.useCallback(async (id: string, fix: string, label: string) => {
    setApplying(id)
    try {
      const r = (await host.call('optimizer/apply', { fix })) as { ok: boolean; message?: string }
      pushLog(`${r.ok ? '✓' : '✗'} ${label}: ${r.message ?? ''}`)
      await runScan()
    } catch (e) {
      pushLog(`✗ ${label}: 异常 ${String(e)}`)
    } finally {
      setApplying(null)
    }
  }, [runScan])

  const fixAll = React.useCallback(async () => {
    if (!scan?.issues) return
    setApplying('all')
    try {
      for (const issue of scan.issues) {
        if (!issue.fix || issue.fix === 'none') continue
        const r = (await host.call('optimizer/apply', { fix: issue.fix })) as { ok: boolean; message?: string }
        pushLog(`${r.ok ? '✓' : '✗'} ${issue.title}: ${r.message ?? ''}`)
      }
      pushLog('一键优化完成')
      await runScan()
    } catch (e) {
      pushLog('一键优化异常: ' + String(e))
    } finally {
      setApplying(null)
    }
  }, [scan, runScan])

  const fixable = scan?.issues?.filter(i => i.fix && i.fix !== 'none') ?? []
  const patch = scan?.patch
  const stats = scan?.stats

  return React.createElement('div', { className: 'dsh-opt-root' },
    React.createElement('div', { className: 'dsh-opt-card' },
      React.createElement('h3', null, '一键优化'),
      React.createElement('div', { className: 'dsh-opt-stats' },
        React.createElement('div', { className: 'dsh-opt-stat' },
          React.createElement('b', null, String(patch?.patched ?? '—')),
          React.createElement('span', null, '分页补丁'),
        ),
        React.createElement('div', { className: 'dsh-opt-stat' },
          React.createElement('b', null, String(stats?.total ?? '—')),
          React.createElement('span', null, '会话总数'),
        ),
        React.createElement('div', { className: 'dsh-opt-stat' },
          React.createElement('b', null, String(stats?.totalMB ?? '—')),
          React.createElement('span', null, '占用 (MB)'),
        ),
        React.createElement('div', { className: 'dsh-opt-stat' },
          React.createElement('b', null, String(stats?.empty ?? '—')),
          React.createElement('span', null, '空会话'),
        ),
      ),
      React.createElement('div', { style: { display: 'flex', gap: '8px', marginTop: '4px' } },
        React.createElement('button', {
          className: 'dsh-opt-btn dsh-opt-btn-primary',
          disabled: loading,
          onClick: runScan,
        }, loading ? '扫描中…' : '一键扫描'),
        React.createElement('button', {
          className: 'dsh-opt-btn',
          disabled: applying !== null || fixable.length === 0,
          onClick: fixAll,
        }, applying === 'all' ? '优化中…' : `一键优化全部 (${fixable.length})`),
      ),
    ),
    React.createElement('div', { className: 'dsh-opt-card' },
      React.createElement('h3', null, '发现的可优化问题'),
      ...(scan === null
        ? [React.createElement('div', { className: 'dsh-opt-empty' }, '正在扫描…')]
        : scan.issues && scan.issues.length > 0
          ? scan.issues.map(issue =>
              React.createElement('div', { className: 'dsh-opt-row', key: issue.id },
                React.createElement('div', { className: 'dsh-opt-row-main' },
                  React.createElement('div', { className: 'dsh-opt-row-title' },
                    React.createElement('span', { className: `dsh-opt-badge dsh-opt-badge-${issue.severity}` }, severityLabel(issue.severity)),
                    React.createElement('span', null, issue.title),
                  ),
                  React.createElement('div', { className: 'dsh-opt-row-detail' }, issue.detail),
                ),
                issue.fix && issue.fix !== 'none'
                  ? React.createElement('button', {
                      className: 'dsh-opt-btn dsh-opt-btn-ghost',
                      disabled: applying !== null,
                      onClick: () => doFix(issue.id, issue.fix, issue.title),
                    }, applying === issue.id ? '处理中…' : '修复')
                  : null,
              ),
            )
          : [React.createElement('div', { className: 'dsh-opt-empty' }, '暂无数据')]),
    ),
    React.createElement('div', { className: 'dsh-opt-card' },
      React.createElement('h3', null, '操作日志'),
      React.createElement('div', { className: 'dsh-opt-log' },
        log.length === 0 ? '暂无操作。点击「一键扫描」开始。' : log.join('\n'),
      ),
    ),
  )
}

export function apply(ctx: Context): void {
  styles.insert(CSS)
  const slots = ctx.get('slots')
  if (slots === undefined) return
  slots.inject('settings.section', () =>
    slots.register(
      { name: 'settings.section', id: 'optimizer', order: 50, label: '优化' },
      (props: { close: () => void }) => React.createElement(OptimizerSettings, { close: props.close }),
    ),
  )
}
