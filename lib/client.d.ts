/**
 * dsh-optimizer client — 设置页「优化」面板
 * 一键扫描 → 列出可优化问题 → 逐项修复 / 一键优化全部。
 * 通过 host.call 与 host 半部通信（optimizer/scan, optimizer/apply）。
 */
import type { Context } from '@deepseek-ai/cordis';
export declare const name = "dsh-optimizer";
export declare const inject: string[];
export declare function apply(ctx: Context): void;
