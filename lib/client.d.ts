/**
 * dsh-optimizer client — 设置页「优化」面板
 * 一键扫描 → 列出可优化问题 → 逐项修复 / 一键优化全部。
 * 通过 host 自建的 HTTP RPC endpoint 通信（/dsh-optimizer/rpc）。
 */
import type { Context } from '@deepseek-ai/cordis';
export declare const name = "dsh-optimizer";
export declare const inject: string[];
export declare function apply(ctx: Context): void;
