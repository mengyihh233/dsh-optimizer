# dsh-optimizer · DSH 优化插件

> 会话切换卡顿的「体检 + 归档 + 补丁」三件套，针对 DeepSeek Harness。

## 这是什么

DSH 切换长会话会卡好几秒，根因是**流式输出块（`assistant/chunk`）事件爆炸**：

一个长会话的日志里，99% 以上的事件是流式生成过程中的 `assistant/chunk` 增量块（实测：单会话 13.3 万事件中 13.2 万是 chunk）。切换会话时，DSH 的 history 分页把这些 chunk **全部返回**并逐个计算视图——50 条消息的一页实际携带约 2.7 万事件，这才是卡顿的来源（不是网络，不是渲染）。

本插件把整套优化方法打包成 4 个模型工具 + 1 个设置页：

| 入口 | 作用 |
|---|---|
| `optimizer_audit` | 会话体检：总数、占用、空会话、最大会话的事件规模与 chunk 占比 |
| `optimizer_archive` | 归档旧/大会话：移出 `~/.dsh/sessions`，切换立刻变快，可恢复 |
| `optimizer_cleanup` | 清理空/损坏会话：先列候选，确认后移入归档（不直接删除） |
| `optimizer_patch` | 补丁管理：给部署的 `dsh-host-apiproxy` 打「history 跳过 chunk」补丁（status / apply / revert） |
| **设置页「优化」** | **一键扫描 → 列出可优化问题 → 逐项修复 / 一键优化全部**（设置 → 优化） |

## 设置页「一键优化」

安装并重启后，侧边栏 **设置 → 优化** 打开面板：

- **状态概览**：分页补丁是否已应用、会话总数、磁盘占用、空会话数
- **一键扫描**：实时扫描部署与会话目录，列出可优化问题（按严重度：高/中/低）
- **逐项修复**：每个问题旁「修复」按钮，单独应用
- **一键优化全部**：顺序应用所有可修复项（应用补丁 + 清理空会话 + 归档旧会话）
- **操作日志**：每次操作的结果（成功/失败 + 提示）

所有操作都可逆：补丁可 `revert`，归档/清理只是把目录移入 `~/.dsh/sessions-archive/`（可手动移回），不直接删除任何数据。

## 安装

```sh
dsh plugin --profile <profile> add github:mengyihh233/dsh-optimizer
```

bundle 插件安装后需要**重启 dsh web** 生效。

## 快速开始

装好后，在会话里直接让模型调用（模型会自动选用）：

- **体检**：`调用 optimizer_audit，full=true，看看最大的几个会话`
- **归档**：`调用 optimizer_archive，olderThanDays=7，minMB=1`（把 7 天未动且超过 1MB 的会话归档）
- **清理空会话**：`调用 optimizer_cleanup`（先看候选）→ `调用 optimizer_cleanup，dryRun=false`（确认后执行）
- **打补丁**：`调用 optimizer_patch，action=status` → `action=apply`（重启 web 后生效）

## 性能数据（本机实测，DSH 0.1.0-rc.5）

- 149 个会话共 46.5MB，最大单会话 3MB 压缩（6MB 明文）
- 最大会话：7560 行 → 解码后 **133,116 事件**，其中 **132,315 个（99.4%）是 `assistant/chunk`**
- 补丁前：50 条消息的 history 页携带 **27,194 个事件**，host 端逐个计算视图 + 传输 5.2MB
- 补丁后：同一页 **211 个事件**（约 **130 倍**减少），host 视图计算 211 次，传输 0.9MB
- 切换长会话从**数秒**降到**亚秒级**

补丁实现：`paginate` 返回页滤 chunk（主要收益，130 倍），并在窗口尾部补回边界事件以保证客户端分页连续性（见下方「补丁说明」的缺陷与修复记录）。

## 补丁说明

`optimizer_patch` 修改的是部署目录下的：

```
node_modules/@deepseek-ai/dsh-host-apiproxy/lib/index.js
```

补丁内容（与上游分支一致，含**边界保序修复**）：

```js
const HISTORY_SKIPPED_TYPES = new Set(["assistant/chunk"]);
// paginate 返回：滤 chunk + 窗口尾部补回边界事件
events: window.filter((event) => event.seq >= cut && !HISTORY_SKIPPED_TYPES.has(event.type)).concat(
  beforeSeq === undefined ? [] : (() => {
    const boundary = window[window.length - 1];
    return boundary !== undefined && boundary.seq >= cut && HISTORY_SKIPPED_TYPES.has(boundary.type) ? [boundary] : [];
  })()
),
```

**缺陷与修复（v0.1.0 → v0.1.1）**：第一版补丁直接滤掉窗口内全部 chunk，结果客户端 `loadOlder` 的连续性检查（`tail.seq + 1 === baseSeq`）几乎必然失败——被滤掉的 chunk 留下 seq 空洞，前端误判为分页断裂并停止加载更早历史（实测 3/3 次失败）。修复：分页计数与页面主体仍滤 chunk（页面仍缩小 ~130 倍），但窗口尾部若原本是 chunk（`beforeSeq-1`），把它补回——连续性检查通过（实测 0 失败），每页只多返回 1 个事件。

- **幂等**：重复 `apply` 安全
- **可回滚**：`action=revert` 恢复原状（已通过 apply→revert→apply→revert 往返验证 + JS 语法检查）
- **升级需重打**：DSH 升级覆盖部署文件后，重新 `apply` 即可
- 部署文件探测顺序：`DSH_DEPLOY_ROOT` 环境变量 → Windows 常见部署根 → `~/.dsh/profiles/*/node_modules`

上游分支（已推送到 fork）：

```
https://github.com/mengyihh233/deepseek-harness/tree/perf/history-skip-chunk
```

> 官方 CONTRIBUTING 说明目前不接受外部 PR；补丁已按同源码推送到上述分支，可在 GitHub Discussions 讨论采纳。

## 兼容性与安全

**与其他插件的兼容性**（本机实测清单）：

- **learn-everything**：它补丁 `dsh-session` 的 known-event-types，本插件补丁 `dsh-host-apiproxy`——不同文件，无冲突；都属部署文件修改，升级后各自需重打
- **liangshen / anchored-wsl（梁神锚定）**：锚定只影响模型工具可见性，`optimizer_*` 工具晋升后可用，无冲突
- **super-wechat-bridge**：微信会话在 sessions 目录（`wechat-*` 前缀）。清理/归档默认只动空会话与 >7 天未动的会话，活跃微信会话不受影响；`optimizer_cleanup` 列出 `wechat-*` 空会话时请确认后再执行
- **mnemon / dsh-ssh / dsh-task-board / dsh-aionui-panel / modlens**：数据各自独立（记忆库、SSH 配置、localStorage、文件面板、Ollama），无交集
- **设置页 slot**：注册 `settings.section` 的 `optimizer` 条目（order 50），不覆盖任何现有设置页

**安全设计**：

- 补丁是**字符串精确匹配**（fail-closed）：部署版本变更导致目标行找不到时，直接报错不写入，绝不盲改
- 归档/清理是**移动而非删除**：全部进 `~/.dsh/sessions-archive/`，可手动移回
- 工具与设置页都**不读取会话内容**，只读文件大小、mtime 等元数据（audit full 模式除外）
- peerDependencies 只声明 `@deepseek-ai/cordis` 与 `dsh-tools`，由 DSH 运行时提供

**已知限制**：

- 补丁是部署文件修改，DSH 升级会被覆盖，需重新 `apply`
- `optimizer_audit` 的 chunk 占比是**行级近似**（打包行按 1 行计），非展开后精确值
- 部署根探测在非 Windows / 非常规安装路径下可能失败——设置 `DSH_DEPLOY_ROOT` 环境变量可解决

## 开发

```sh
npm install        # typescript + @types/node（@deepseek-ai/* 由 DSH 运行时提供，peerDependencies）
npm run build      # tsc 编译 src → lib
```

## 许可证

MIT
