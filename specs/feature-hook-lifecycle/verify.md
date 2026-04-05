# Hook 生命周期模块化 — 验证指南

## 改动概要

| 改动 | 文件 |
|------|------|
| 子模块统一导出 | `src/utils/hooks/index.ts` |
| Core 类型/函数 re-export | `src/utils/hooks/core/types.ts`, `core/executor.ts`, `core/matcher.ts`, `core/config.ts`, `core/index.ts` |
| 工具事件模块 | `src/utils/hooks/events/toolEvents.ts` |
| 会话事件模块 | `src/utils/hooks/events/sessionEvents.ts` |
| 压缩事件模块 | `src/utils/hooks/events/compactEvents.ts` |
| Agent 事件模块 | `src/utils/hooks/events/agentEvents.ts` |
| 团队事件模块 | `src/utils/hooks/events/teamEvents.ts` |
| 通知事件模块 | `src/utils/hooks/events/notificationEvents.ts` |
| 权限事件模块 | `src/utils/hooks/events/permissionEvents.ts` |
| 环境事件模块 | `src/utils/hooks/events/envEvents.ts` |
| Worktree 事件模块 | `src/utils/hooks/events/worktreeEvents.ts` |
| 事件统一导出 | `src/utils/hooks/events/index.ts` |
| 执行器模块 | `src/utils/hooks/executors/index.ts` |
| 模块导出测试 | `src/utils/hooks/__tests__/moduleExports.test.ts` |
| 调用方迁移（20 文件） | `src/services/notifier.ts`, `src/query.ts`, `src/services/tools/toolExecution.ts`, `src/cli/structuredIO.ts`, `src/cli/print.ts`, `src/tools/AgentTool/runAgent.ts`, `src/commands/compact/compact.ts`, `src/setup.ts`, `src/hooks/toolPermission/PermissionContext.ts`, `src/query/stopHooks.ts`, `src/services/tools/toolHooks.ts`, `src/services/compact/compact.ts`, `src/services/mcp/elicitationHandler.ts`, `src/tools/TaskCreateTool/TaskCreateTool.ts`, `src/tools/TaskUpdateTool/TaskUpdateTool.ts`, `src/commands/clear/conversation.ts`, `src/screens/REPL.tsx`, `src/components/StatusLine.tsx`, `src/hooks/fileSuggestions.ts`, `src/bridge/bridgeMain.ts` |
| 根 hooks.ts | **未修改** — 仍为底层实现，被子模块 re-export |

## 1. 单元测试

```bash
# 全量测试（2204 pass, 0 fail）
bun test

# 仅 hook 模块导出测试（47 个）
bun test src/utils/hooks/__tests__/moduleExports.test.ts

# 原有 hooks 相关测试（确认未回归）
bun test src/utils/__tests__/collapseHookSummaries.test.ts
```

预期：全部通过，无新增失败。

## 2. Re-export 引用同一性验证

```bash
bun -e "
const original = require('./src/utils/hooks.js');
const toolEvents = require('./src/utils/hooks/events/toolEvents.js');
const sessionEvents = require('./src/utils/hooks/events/sessionEvents.js');
const compactEvents = require('./src/utils/hooks/events/compactEvents.js');
const agentEvents = require('./src/utils/hooks/events/agentEvents.js');
const teamEvents = require('./src/utils/hooks/events/teamEvents.js');
const notificationEvents = require('./src/utils/hooks/events/notificationEvents.js');
const permissionEvents = require('./src/utils/hooks/events/permissionEvents.js');
const envEvents = require('./src/utils/hooks/events/envEvents.js');
const worktreeEvents = require('./src/utils/hooks/events/worktreeEvents.js');
const executors = require('./src/utils/hooks/executors/index.js');

const checks = [
  ['executePreToolHooks', toolEvents.executePreToolHooks, original.executePreToolHooks],
  ['executeStopHooks', sessionEvents.executeStopHooks, original.executeStopHooks],
  ['executeSessionStartHooks', sessionEvents.executeSessionStartHooks, original.executeSessionStartHooks],
  ['executePreCompactHooks', compactEvents.executePreCompactHooks, original.executePreCompactHooks],
  ['executeSubagentStartHooks', agentEvents.executeSubagentStartHooks, original.executeSubagentStartHooks],
  ['executeTeammateIdleHooks', teamEvents.executeTeammateIdleHooks, original.executeTeammateIdleHooks],
  ['executeNotificationHooks', notificationEvents.executeNotificationHooks, original.executeNotificationHooks],
  ['executePermissionRequestHooks', permissionEvents.executePermissionRequestHooks, original.executePermissionRequestHooks],
  ['executeCwdChangedHooks', envEvents.executeCwdChangedHooks, original.executeCwdChangedHooks],
  ['executeWorktreeCreateHook', worktreeEvents.executeWorktreeCreateHook, original.executeWorktreeCreateHook],
  ['executeStatusLineCommand', executors.executeStatusLineCommand, original.executeStatusLineCommand],
];

let allPass = true;
for (const [name, actual, expected] of checks) {
  const pass = actual === expected;
  if (!pass) { allPass = false; console.log('FAIL:', name); }
}
console.log(allPass ? 'ALL CHECKS PASSED — same references' : 'SOME CHECKS FAILED');
"
```

预期：`ALL CHECKS PASSED — same references`。所有 re-export 都指向原始 hooks.ts 中的同一个函数引用。

## 3. 调用方迁移完整性验证

```bash
# 确认不再有文件从根 hooks.ts 导入（hooks/ 子目录除外）
grep -rn "from ['\"].*utils/hooks\.js['\"]" src/ --include='*.ts' --include='*.tsx' | grep -v 'src/utils/hooks/'
# 预期：无输出

# 确认所有子模块文件存在
ls src/utils/hooks/core/
# 预期: config.ts  executor.ts  index.ts  matcher.ts  types.ts

ls src/utils/hooks/events/
# 预期: agentEvents.ts  compactEvents.ts  envEvents.ts  index.ts
#       notificationEvents.ts  permissionEvents.ts  sessionEvents.ts
#       teamEvents.ts  toolEvents.ts  worktreeEvents.ts

ls src/utils/hooks/executors/
# 预期: index.ts
```

预期：无残留的旧路径引用，所有新文件存在。

## 4. 交互式 REPL 验证

```bash
bun run dev
```

交互操作：
1. 发送 `say hello` — 验证正常流式响应（不涉及 hook）
2. 发送 `create a file called /tmp/test-hook-mod.txt with content "hello"` — 验证 PreToolUse / PostToolUse hook 路径正常（toolEvents 模块）
3. 发送 `read the file /tmp/test-hook-mod.txt` — 验证 Read 工具 hook 路径正常
4. 发送 `/compact` — 验证 PreCompact / PostCompact hook 路径正常（compactEvents 模块）
5. 输入后回车 — 验证 UserPromptSubmit hook 路径正常（sessionEvents 模块）

预期：所有操作行为与改动前完全一致。

## 5. Hook 配置触发验证

如果你有配置 hooks（在 `.claude/settings.json` 中），可以测试：

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Write",
        "hooks": [{ "type": "command", "command": "echo 'PreToolUse Write hook fired'" }]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "echo 'PostToolUse Bash hook fired'" }]
      }
    ]
  }
}
```

```bash
bun run dev
```

交互操作：
1. 发送 `create a file called /tmp/hook-test.txt with content "test"` — 观察 PreToolUse Write hook 触发
2. 发送 `run ls /tmp/` — 观察 PostToolUse Bash hook 触发
3. 退出 `/exit` — 观察 SessionEnd hook 触发（sessionEvents 模块）

预期：Hook 正常触发，输出与改动前一致。

## 6. 代码结构验证

```bash
# 确认 hooks.ts 未被修改
git diff HEAD~2 -- src/utils/hooks.ts | head -5
# 预期：无输出（未修改）

# 确认调用方已迁移
git diff HEAD~1 --name-only | head -25
# 预期：列出 20 个迁移的调用方文件
```

## 7. Lint 检查

```bash
bun run lint
```

预期：新文件无新增 lint error（已有 error 为预存的，非本次引入）。

## 8. 构建验证

```bash
bun run build
```

预期：构建成功，产物可运行。

## 回归风险点

| 场景 | 风险 | 验证方式 |
|------|------|---------|
| Hook 不触发 | 高 — 所有工具调用前的安全检查 | 配置 PreToolUse hook，验证工具调用时触发 |
| Hook 输出丢失 | 高 — PostToolUse 修改 MCP 输出 | 配置 PostToolUse hook 返回 updatedMCPToolOutput |
| 会话启动 hook | 中 — SessionStart 初始化 | 检查启动时 SessionStart hook 正常执行 |
| Stop hook 阻断 | 中 — Stop hook exit code 2 | 配置 Stop hook 返回 exit code 2，验证阻断生效 |
| 权限请求 hook | 中 — 自动审批权限 | 配置 PermissionRequest hook，验证自动审批 |
| 状态栏显示 | 低 — StatusLine 执行器路径 | 检查状态栏正常显示 |
| 文件建议 | 低 — FileSuggestion 执行器路径 | 输入路径时验证文件建议正常 |
| 动态 import | 低 — bridgeMain.ts | 验证 worktree 相关功能的动态导入 |

## 调用链路（改动后）

```
调用方 import                      原始 import
  ↓                                   ↓
events/toolEvents.ts              →  hooks.ts (re-export)
events/sessionEvents.ts           →  hooks.ts (re-export)
events/compactEvents.ts           →  hooks.ts (re-export)
events/agentEvents.ts             →  hooks.ts (re-export)
events/teamEvents.ts              →  hooks.ts (re-export)
events/notificationEvents.ts      →  hooks.ts (re-export)
events/permissionEvents.ts        →  hooks.ts (re-export)
events/envEvents.ts               →  hooks.ts (re-export)
events/worktreeEvents.ts          →  hooks.ts (re-export)
core/types.ts                     →  hooks.ts (re-export)
executors/index.ts                →  hooks.ts (re-export)
                                     ↓
                               hooks.ts（5177行，未修改）
                               内部执行引擎、shell spawn、matcher 等
```

所有子模块 re-export hooks.ts 的原始导出，函数引用完全相同（`===`），无行为变化。

## 后续迁移路线

当前架构为薄代理层，后续可逐步：
1. 将 `hooks.ts` 中的 `execute*` 函数体真正提取到 `events/` 子模块
2. 将 `execCommandHook` 提取到 `executors/commandHook.ts`
3. 将 `getMatchingHooks` / `matchesPattern` 提取到 `core/matcher.ts`
4. 完成后 `hooks.ts` 变为空壳或删除
