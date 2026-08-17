# dsh-optimizer · DSH 优化插件

> 会话切换卡顿的「体检 + 归档 + 补丁」三件套，针对 DeepSeek Harness。

## 这是什么

DSH 切换长会话会卡好几秒，根因是**流式输出块（`assistant/chunk`）事件爆炸**：

一个长会话的日志里，99% 以上的事件是流式生成过程中的 `assistant/chunk` 增量块（实测：单会话 13.3 万事件中 13.2 万是 chunk）。切换会话时，DSH 的 history 分页把这些 chunk **全部返回**并逐个计算视图——50 条消息的一页实际携带约 2.7 万事件，这才是卡顿的来源（不是网络，不是渲染）。

本插件把整套优化方法打包成 4 个工具：

| 工具 | 作用 |
|---|---|
| `optimizer_audit` | 会话体检：总数、占用、空会话、最大会话的事件规模与 chunk 占比 |
| `optimizer_archive` | 归档旧/大会话：移出 `~/.dsh/sessions`，切换立刻变快，可恢复 |
| `optimizer_cleanup` | 清理空/损坏会话：先列候选，确认后移入归档（不直接删除） |
| `optimizer_patch` | 补丁管理：给部署的 `dsh-host-apiproxy` 打「history 跳过 chunk」补丁（status / apply / revert） |

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

## 补丁说明

`optimizer_patch` 修改的是部署目录下的：

```
node_modules/@deepseek-ai/dsh-host-apiproxy/lib/index.js
```

补丁内容（与上游分支一致）：

```js
const HISTORY_SKIPPED_TYPES = new Set(["assistant/chunk"]);
// paginate 返回行追加: && !HISTORY_SKIPPED_TYPES.has(event.type)
```

原理：`assistant/chunk` 只在流式生成时有用，聚合后的 `assistant/message` 已包含完整内容；历史视图、搜索、追踪、前端组装都不消费 chunk 行。分页计数逻辑不变（chunk 本来就不计入 `maxMessages`），页边界与 `hasMore` 完全一致。

- **幂等**：重复 `apply` 安全
- **可回滚**：`action=revert` 恢复原状
- **升级需重打**：DSH 升级覆盖部署文件后，重新 `apply` 即可
- 部署文件探测顺序：`DSH_DEPLOY_ROOT` 环境变量 → Windows 常见部署根 → `~/.dsh/profiles/*/node_modules`

上游分支（已推送到 fork，供维护者参考）：

```
https://github.com/mengyihh233/deepseek-harness/tree/perf/history-skip-chunk
```

> 官方 CONTRIBUTING 说明目前不接受外部 PR；补丁已按同源码推送到上述分支，可在 GitHub Discussions 讨论采纳。

## 开发

```sh
npm install        # typescript + @types/node（@deepseek-ai/* 由 DSH 运行时提供，peerDependencies）
npm run build      # tsc 编译 src → lib
```

## 许可证

MIT
