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
import type { Context } from '@deepseek-ai/cordis';
export declare const name = "dsh-optimizer";
export declare const inject: string[];
export declare function apply(ctx: Context): void;
