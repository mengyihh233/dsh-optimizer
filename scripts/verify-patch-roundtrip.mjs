// 干净版：复制当前部署文件（正确补丁态）→ 测 revert → 再测 apply → 再测 revert
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const srcFile = 'D:\\deepseek harness\\resources\\host\\node_modules\\@deepseek-ai\\dsh-host-apiproxy\\lib\\index.js';

const PATCH_START = '// dsh-optimizer:start';
const PATCH_END = '// dsh-optimizer:end';
const PATCH_BLOCK = `${PATCH_START}\nconst HISTORY_SKIPPED_TYPES = new Set(["assistant/chunk"]);\n${PATCH_END}`;
const PATCH_TARGET_LINE = `const MESSAGE_TYPES = new Set(["user/message", "assistant/message"]);`;
const PAGINATE_FROM = `events: window.filter((event) => event.seq >= cut),`;
const PAGINATE_PATCHED_RE = /events: window\.filter\(\(event\) => event\.seq >= cut && !HISTORY_SKIPPED_TYPES\.has\(event\.type\)\)\.concat\([\s\S]*?\n\s*\),/;

function applyPatch(file) {
  let src = readFileSync(file, 'utf8');
  if (src.includes(PATCH_START)) return 'already';
  if (!src.includes(PATCH_TARGET_LINE)) return 'no-target';
  if (!src.includes(PAGINATE_FROM)) return 'no-from';
  src = src.replace(PATCH_TARGET_LINE, PATCH_TARGET_LINE + '\n' + PATCH_BLOCK);
  src = src.replace(PAGINATE_FROM, `events: window.filter((event) => event.seq >= cut && !HISTORY_SKIPPED_TYPES.has(event.type)).concat(\n\t\t\tbeforeSeq === void 0 ? [] : (() => {\n\t\t\t\tconst boundary = window[window.length - 1];\n\t\t\t\treturn boundary !== void 0 && boundary.seq >= cut && HISTORY_SKIPPED_TYPES.has(boundary.type) ? [boundary] : [];\n\t\t\t})()\n\t\t),`);
  writeFileSync(file, src, 'utf8');
  return 'applied';
}

function revertPatch(file) {
  let src = readFileSync(file, 'utf8');
  if (!src.includes(PATCH_START) && !src.includes('HISTORY_SKIPPED_TYPES')) return 'none';
  let out = src;
  out = out.replace(PAGINATE_PATCHED_RE, PAGINATE_FROM);
  const startIdx = out.indexOf(PATCH_START);
  if (startIdx >= 0) {
    const endIdx = out.indexOf(PATCH_END, startIdx);
    if (endIdx >= 0) out = out.slice(0, startIdx) + out.slice(endIdx + PATCH_END.length);
  }
  out = out.split('\n').filter(line => line.trim() !== `const HISTORY_SKIPPED_TYPES = new Set(["assistant/chunk"]);`).join('\n');
  writeFileSync(file, out, 'utf8');
  return 'reverted';
}

function syntaxOk(file) {
  try {
    execSync(`node --check "${file}"`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function check(name, cond) {
  console.log(`${cond ? '✅' : '❌'} ${name}`);
  return cond;
}

let allOk = true;

// 场景 1：从当前补丁态 revert → 应恢复原版
const f1 = join(tmpdir(), 'apiproxy-test-1.js');
copyFileSync(srcFile, f1);
const r1 = revertPatch(f1);
const s1 = readFileSync(f1, 'utf8');
allOk &= check(`1) revert(${r1}): 无 HISTORY_SKIPPED_TYPES = ${!s1.includes('HISTORY_SKIPPED_TYPES')}`, !s1.includes('HISTORY_SKIPPED_TYPES'));
allOk &= check(`   revert: 无 concat 边界逻辑 = ${!s1.includes('const boundary = window')}`, !s1.includes('const boundary = window'));
allOk &= check(`   revert: paginate 恢复原版行 = ${s1.includes(PAGINATE_FROM)}`, s1.includes(PAGINATE_FROM));
allOk &= check(`   revert: JS 语法 = ${syntaxOk(f1)}`, syntaxOk(f1));

// 场景 2：对 revert 后的文件 apply → 应回到补丁态
const a1 = applyPatch(f1);
const s2 = readFileSync(f1, 'utf8');
allOk &= check(`2) apply(${a1}): 含 PATCH_START = ${s2.includes(PATCH_START)}`, s2.includes(PATCH_START));
allOk &= check(`   apply: 含 concat 边界逻辑 = ${s2.includes('const boundary = window')}`, s2.includes('const boundary = window'));
allOk &= check(`   apply: JS 语法 = ${syntaxOk(f1)}`, syntaxOk(f1));

// 场景 3：再次 apply → 幂等
const a2 = applyPatch(f1);
allOk &= check(`3) apply 幂等 = ${a2 === 'already'}`, a2 === 'already');

// 场景 4：再 revert → 恢复原版
const r2 = revertPatch(f1);
const s4 = readFileSync(f1, 'utf8');
allOk &= check(`4) revert(${r2}): 无补丁残留 = ${!s4.includes('HISTORY_SKIPPED_TYPES') && !s4.includes('const boundary = window')}`, !s4.includes('HISTORY_SKIPPED_TYPES') && !s4.includes('const boundary = window'));
allOk &= check(`   revert: paginate 恢复 = ${s4.includes(PAGINATE_FROM)}`, s4.includes(PAGINATE_FROM));
allOk &= check(`   revert: JS 语法 = ${syntaxOk(f1)}`, syntaxOk(f1));

console.log('\n' + (allOk ? '✅ 全部通过' : '❌ 有失败'));
