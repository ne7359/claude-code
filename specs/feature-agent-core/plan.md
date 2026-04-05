# Agent Core — 实施计划

> 设计文档: `specs/feature-agent-core/design.md`
> 优先级: P1
> 风险: 高
> 日期: 2026-04-05

---

## 〇、核心原则

本计划遵循 `design.md` 中定义的**包独立与通信边界**原则：

1. **`packages/agent` 零运行时依赖** — 不 import `src/`、React、Ink、`bun:bundle`
2. **依赖倒置** — `packages/agent` 定义 `AgentDeps` 接口，主包 (`src/`) 提供实现
3. **事件驱动输出** — 核心循环唯一输出通道为 `AsyncGenerator<AgentEvent>`
4. **构造时注入** — `AgentDeps` 在 `new AgentCore(deps)` 时绑定，运行时不可变
5. **测试独立** — `bun test packages/agent/` 无需主包环境

---

## 一、当前状态分析

### 核心文件

| 文件 | 行数 | 职责 |
|------|------|------|
| `src/query.ts` | 1732 | 核心消息循环：LLM 调用 → 工具执行 → compaction → 循环 |
| `src/QueryEngine.ts` | 1320 | 会话编排层：prompt 构建、消息管理、SDK 转换、包装 query() |
| `src/query/deps.ts` | 40 | 现有 DI 层（4 个 deps：callModel, microcompact, autocompact, uuid） |
| `src/query/config.ts` | 47 | 不可变运行时配置（sessionId, gates） |
| `src/query/stopHooks.ts` | 474 | Stop hook 执行 + TaskCompleted/TeammateIdle hook |
| `src/query/tokenBudget.ts` | 93 | Token 预算续写决策 |
| `src/query/transitions.ts` | 3 | 终止/继续类型（stub） |
| `src/Tool.ts` | 792 | Tool 接口 + `ToolUseContext`（~40 字段巨型上下文） |
| `src/tools.ts` | 406 | 工具注册（54 工具，硬编码列表） |
| `src/tools/registry/ToolRegistry.ts` | ~150 | 已实现的 ToolRegistry 类（O(1) 查找、动态注册、权限过滤） |
| `src/types/message.ts` | 167 | Message 类型层级（宽 bag 类型） |

### 直接调用方

| 调用方 | 导入内容 | 用途 |
|--------|---------|------|
| `src/cli/print.ts` | `ask` (from QueryEngine) | Pipe/headless 模式 |
| `src/screens/REPL.tsx` | `QueryEngine` class | 交互式 REPL |
| `src/bridge/` | 通过 QueryEngine 或直接 | Bridge/远程控制模式 |

### 核心循环直接耦合的模块

| 模块 | import 路径 | 耦合原因 |
|------|-----------|---------|
| API 客户端 | `services/api/claude.ts` | `queryModelWithStreaming` — 已通过 deps 抽象 |
| Compaction (auto) | `services/compact/autoCompact.ts` | `autoCompactIfNeeded` — 已通过 deps 抽象 |
| Compaction (micro) | `services/compact/microCompact.ts` | `microcompactMessages` — 已通过 deps 抽象 |
| Compaction (snip/reactive/collapse) | 各 compact 模块 | 直接 import，未通过 deps |
| 工具执行 | `services/tools/toolOrchestration.ts` | `StreamingToolExecutor`, `runTools` 直接 import |
| Stop hooks | `query/stopHooks.ts` | `handleStopHooks` — 内部又依赖 hooks/ 全套 |
| Token budget | `query/tokenBudget.ts` | `checkTokenBudget` — 纯逻辑，可复用 |
| 权限 | `hooks/useCanUseTool.tsx` | 通过 `CanUseToolFn` 回调 — React bound |
| 分析日志 | `services/analytics/index.js` | `logEvent` 散布 ~10 处 |
| Feature flags | `bun:bundle` | ~10 个 `feature()` 调用控制路径 |
| 消息构建 | `utils/messages.ts` | `createUserMessage` 等 — 纯函数 |
| 队列 | 内部 queue 管理 | 命令队列 drain 逻辑 |
| 附件 | `utils/attachments.ts` | `getAttachmentMessages` 等 |

---

## 二、目标

1. **创建独立包 `packages/agent`** — 零运行时依赖，可独立测试和发布
2. **定义纯净的 AgentCore 接口** — 消费者（REPL/SDK/Bridge/Swarm）只依赖接口，不依赖实现
3. **将核心循环与 UI/状态/分析解耦** — `query()` 中所有外部依赖通过 `AgentDeps` 注入
4. **拆分 QueryEngine** — 会话编排（prompt/持久化/SDK 转换）与核心循环分离
5. **主包仅提供 Deps 适配器** — `src/` 中的适配器实现桥接现有代码到 `AgentDeps` 接口

---

## 三、目标架构

### 包结构

```
packages/agent/                          ← 独立包，零外部运行时依赖
├── package.json                         # { name: "@anthropic/agent", private: true, type: "module" }
├── index.ts                             # 公共导出 (AgentCore, AgentDeps, AgentEvent 等)
├── core/
│   ├── AgentCore.ts                     # AgentCore 实现 — 消费者的入口类
│   ├── AgentLoop.ts                     # 核心消息循环 (from query.ts)
│   └── state.ts                         # AgentState, TurnState 内部状态管理
├── types/
│   ├── deps.ts                          # AgentDeps 8 个子接口定义
│   ├── events.ts                        # AgentEvent 联合类型 + DoneReason
│   ├── state.ts                         # AgentState, AgentInput 公共类型
│   ├── messages.ts                      # CoreMessage 严格子集（核心层消息类型）
│   └── tools.ts                         # CoreTool, ToolResult, ToolExecContext
├── internal/
│   ├── tokenBudget.ts                   # Token 预算逻辑 (from query/tokenBudget.ts)
│   ├── config.ts                        # AgentConfig 不可变配置 (from query/config.ts)
│   ├── queue.ts                         # 命令队列管理
│   └── abort.ts                         # 中断处理逻辑
└── __tests__/
    ├── AgentLoop.test.ts                # 核心循环单元测试（全部 deps mock）
    ├── AgentCore.test.ts                # 公共 API 集成测试
    └── fixtures/
        └── mockDeps.ts                  # 标准化 mock deps 工厂
```

```
src/                                     ← 主包（消费者 + 适配器实现）
├── agent/                               ← 适配器层（桥接 packages/agent 到现有代码）
│   ├── createDeps.ts                    # createProductionDeps(toolUseContext) 工厂
│   ├── ProviderDepImpl.ts              # 包装 services/api/claude.ts
│   ├── ToolDepImpl.ts                   # 包装 ToolRegistry + toolExecution
│   ├── PermissionDepImpl.ts             # 包装 useCanUseTool + permissions pipeline
│   ├── OutputDepImpl.ts                 # 包装 Ink / JSON / Silent 渲染
│   ├── HookDepImpl.ts                   # 包装 hooks.ts + stopHooks.ts
│   ├── CompactionDepImpl.ts             # 包装 services/compact/* (5种策略)
│   ├── ContextDepImpl.ts                # 包装 context.ts + systemPrompt
│   └── SessionDepImpl.ts                # 包装 sessionStorage + state.ts
├── query.ts                             # 退化为薄包装层 (< 50 行)
├── QueryEngine.ts                       # 会话编排层，内部使用 AgentCore
└── screens/REPL.tsx                     # UI 层，消费 AgentEvent 事件流
```

### 依赖方向图

```text
┌─────────────────┐
│  packages/agent  │ ← 零运行时依赖
│  (纯接口 + 逻辑) │ ← 定义 AgentDeps, AgentEvent, AgentCore
└────────┬────────┘
         │ 被 import
         ▼
┌─────────────────┐
│    src/agent/    │ ← 适配器层 (实现 AgentDeps 接口)
│  (Deps 适配器)   │ ← import packages/agent 的接口 + src/ 的具体实现
└────────┬────────┘
         │ 被调用
         ▼
┌─────────────────┐
│  src/ 现有代码   │ ← services/api, tools/, hooks/, compact/ 等
│  (具体实现)      │ ← 不感知 packages/agent 的存在
└─────────────────┘
```

**关键**: `src/` 中的现有代码 (services/api/, tools/, hooks/ 等) **不需要任何修改**。它们不感知 `packages/agent` 的存在。只有适配器层 (`src/agent/`) 同时 import 两边。

---

## 四、分步实施计划

### Phase 0: 基础类型定义 [纯新增，不改现有代码]

#### 4.1 创建 `packages/agent/package.json`

```json
{
  "name": "@anthropic/agent",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./index.ts",
  "types": "./index.ts"
}
```

**风险**: 低
**依赖**: 无

#### 4.2 创建 `packages/agent/types/events.ts` — AgentEvent 联合类型

**状态**: 新建
**工作**: 定义核心事件流类型，替代当前 `StreamEvent | RequestStartEvent | Message | TombstoneMessage | ToolUseSummaryMessage` 的松散联合。

```typescript
// 统一事件流 — AgentCore.run() 的 yield 类型
export type AgentEvent =
  | { type: 'message'; message: Message }
  | { type: 'stream'; event: StreamEvent }
  | { type: 'tool_start'; toolUseId: string; toolName: string; input: unknown }
  | { type: 'tool_progress'; toolUseId: string; progress: unknown }
  | { type: 'tool_result'; toolUseId: string; result: ToolResult }
  | { type: 'permission_request'; tool: Tool; input: unknown; resolve: (result: PermissionResult) => void }
  | { type: 'compaction'; before: Message[]; after: Message[] }
  | { type: 'request_start'; params: unknown }
  | { type: 'done'; reason: DoneReason; usage?: Usage }

export type DoneReason =
  | 'end_turn'        // LLM 返回 end_turn，无 tool_use
  | 'max_turns'       // 达到 turn 上限
  | 'interrupted'     // 用户中断
  | 'error'           // 不可恢复错误
  | 'stop_hook'       // stop hook 阻止继续
  | 'budget'          // token 预算耗尽
```

**风险**: 低 — 纯类型定义
**依赖**: 4.1

#### 4.3 创建 `packages/agent/types/state.ts` — AgentState 接口

**状态**: 新建

```typescript
export interface AgentState {
  messages: readonly Message[]
  turnCount: number
  totalUsage: Usage
  model: string
  sessionId: string
}

export interface AgentInput {
  prompt: string
  messages: Message[]
  maxTurns?: number
  abortSignal?: AbortSignal
  taskBudget?: number
}
```

**风险**: 低
**依赖**: 4.1

#### 4.4 创建 `packages/agent/types/deps.ts` — AgentDeps 接口

**状态**: 新建

```typescript
export interface AgentDeps {
  provider: ProviderDep
  tools: ToolDep
  permission: PermissionDep
  output: OutputDep
  hooks: HookDep
  compaction: CompactionDep
  context: ContextDep
  session: SessionDep
}

// 每个子接口对应一个外部能力的抽象
// 详见 design.md "AgentDeps 详细设计" 章节
```

**风险**: 低 — 纯类型。但需要与各上游 feature 的设计文档对齐接口签名。
**依赖**: 4.2, 4.3（AgentEvent, AgentState 在 deps 中被引用）

#### 4.5 创建 `packages/agent/index.ts` — 公共导出

**状态**: 新建

```typescript
// 公共 API
export { AgentCore } from './core/AgentCore.js'

// 类型
export type { AgentDeps, ProviderDep, ToolDep, /* ... */ } from './types/deps.js'
export type { AgentEvent, DoneReason } from './types/events.js'
export type { AgentState, AgentInput } from './types/state.js'
export type { CoreMessage } from './types/messages.js'
```

**风险**: 低
**依赖**: 4.2–4.4

---

### Phase 1: 内部纯逻辑迁移 [不改核心循环]

#### 4.6 创建 `packages/agent/internal/` — 提取纯逻辑模块

**状态**: 新建
**工作**: 将 `src/query/` 下的纯逻辑文件迁入 `packages/agent/internal/`。

| 源文件 | 目标 | 改动 |
|--------|------|------|
| `src/query/tokenBudget.ts` (93行) | `internal/tokenBudget.ts` | 直接搬迁，无改动 |
| `src/query/config.ts` (47行) | `internal/config.ts` | 移除 `getSessionId` 直接 import，改为参数传入 |
| `src/query/transitions.ts` (3行) | `internal/transitions.ts` | 填充实际类型（当前 stub） |

**验证**: 搬迁后的文件不包含任何 `src/` import。

**风险**: 低 — 纯逻辑搬迁
**依赖**: 4.1

---

### Phase 2: 主包适配器层 [桥接现有实现到 AgentDeps 接口]

#### 4.7 创建 `src/agent/` — 适配器实现

**状态**: 新建
**工作**: 为每个 `AgentDeps` 子接口创建适配器，内部调用 `src/` 中的具体实现。

| 文件 | 桥接目标 | 实现状态 | 包装内容 |
|------|---------|---------|---------|
| `ProviderDepImpl.ts` | `services/api/provider/` | **上游已实现** | 委托到 `ProviderRegistry.queryWithProvider()` |
| `ToolDepImpl.ts` | `tools/registry/ToolRegistry.ts` | **上游已实现** | 委托到 `ToolRegistry.get()` + `toolExecution` |
| `PermissionDepImpl.ts` | `hooks/useCanUseTool.tsx` + `utils/permissions/` | 待实现 | 将 React hook 回调包装为纯 async 函数 |
| `OutputDepImpl.ts` | （新实现） | 待实现 | 默认 no-op；REPL 传入 Ink 渲染；SDK 传入 JSON 流 |
| `HookDepImpl.ts` | `utils/hooks/events/` | **上游已实现** | 委托到模块化的 `executeStopHooks` 等 |
| `CompactionDepImpl.ts` | `services/compact/` | 待实现 | 包装 5 种策略，统一为 `maybeCompact()` |
| `ContextDepImpl.ts` | `context.ts` + `systemPrompt` | 待实现 | 包装 prompt 构建和环境信息 |
| `SessionDepImpl.ts` | `bootstrap/state.ts` + `sessionStorage` | 待实现 | 包装 session ID 和转录记录 |

**关键设计决策**:

**ProviderDepImpl** — 委托到已实现的 Provider 适配器层 (be53008):
```typescript
// ProviderRegistry 已提供统一 API
import { queryWithProvider, getProvider } from '../services/api/provider/index.js'

class ProviderDepImpl implements ProviderDep {
  stream(params) {
    // 将 AgentStreamParams 映射到 ProviderAdapter.QueryParams
    return queryWithProvider(mapParams(params))
  }
  getModel() {
    return getProvider().capabilities.model ?? defaultModel
  }
}
```

**ToolDepImpl** — 委托到已实现的 ToolRegistry (75f4962):
```typescript
// ToolRegistry 已提供 O(1) 查找 + 过滤 + 组装
import { ToolRegistry } from '../tools/registry/index.js'

class ToolDepImpl implements ToolDep {
  private registry: ToolRegistry  // 从 ToolUseContext 获取
  find(name) { return this.registry.get(name) }
  async execute(tool, input, ctx) { /* 委托到 toolExecution */ }
}
```

**HookDepImpl** — 委托到已模块化的 hooks (2853ea3):
```typescript
// hooks 已按职责分组到 events/ 子模块
import { executeStopHooks, executeSessionEndHooks } from '../utils/hooks/events/sessionEvents.js'
import { executePreToolHooks, executePostToolHooks } from '../utils/hooks/events/toolEvents.js'

class HookDepImpl implements HookDep {
  async onStop(messages, ctx) { return executeStopHooks(messages, ctx) }
  async onTurnStart(state) { /* 可选: executeSessionStartHooks */ }
  async onTurnEnd(state) { /* 可选: executeSessionEndHooks */ }
}
```

**PermissionDepImpl** 是最复杂的适配器：当前 `CanUseToolFn` 是 React hook 返回的回调，内部会触发 UI 弹窗。适配器持有此回调引用，桥接为纯 Promise 接口。

**CompactionDepImpl** 需要统一 5 种策略。内部根据 feature flags 决定调用哪些策略，外部只暴露 `maybeCompact()` 一个方法。

所有适配器都 import `src/` 的具体实现，但实现 `packages/agent` 定义的接口。

**风险**: 中 — 适配器需要确保不遗漏现有行为
**依赖**: Phase 0 (AgentDeps 接口定义)

#### 4.8 创建 `src/agent/createDeps.ts` — 适配器工厂

**状态**: 新建

```typescript
import type { AgentDeps } from '@anthropic/agent'
import { ProviderDepImpl } from './ProviderDepImpl.js'
import { ToolDepImpl } from './ToolDepImpl.js'
// ... 其他适配器
import { ToolRegistry } from '../tools/registry/index.js'

export function createProductionDeps(ctx: ToolUseContext): AgentDeps {
  // 从 ToolUseContext 提取已有的 registry 实例
  const registry = /* 获取 ToolRegistry 单例 */
  return {
    provider: new ProviderDepImpl(ctx),
    tools: new ToolDepImpl(registry),
    permission: new PermissionDepImpl(ctx),
    output: new OutputDepImpl(ctx),
    hooks: new HookDepImpl(ctx),
    compaction: new CompactionDepImpl(ctx),
    context: new ContextDepImpl(ctx),
    session: new SessionDepImpl(ctx),
  }
}
```

**风险**: 低 — 工厂函数只是组装
**依赖**: 4.7

---

### Phase 3: 核心循环迁移 [将 query() 逻辑迁入 AgentLoop]

#### 4.9 创建 `packages/agent/core/AgentLoop.ts` — 核心循环

**状态**: 新建
**工作**: 将 `src/query.ts` 中的 `queryLoop()` 函数逻辑迁入此类。这是**最大的改动**。

**迁移映射表** (注意上游模块变更):

| 循环中的操作 | 当前代码 | AgentLoop 替换 |
|-------------|---------|---------------|
| LLM 调用 | `deps.callModel()` (已有 DI) → `ProviderRegistry.queryWithProvider()` | `this.deps.provider.stream()` |
| 工具查找 | `tools.ts getAllBaseTools()` → 已迁移到 `ToolRegistry` | `this.deps.tools.find()` |
| 工具执行 | `StreamingToolExecutor` / `runTools` | `this.deps.tools.execute()` |
| 权限检查 | `canUseTool()` 回调 | `this.deps.permission.canUseTool()` |
| Hook 执行 | `handleStopHooks()` → 已模块化到 `utils/hooks/events/` | `this.deps.hooks.onStop()` |
| Compaction (5种) | 5 个直接 import | `this.deps.compaction.maybeCompact()` |
| 分析日志 | `logEvent()` 直接调用 | 由 deps 内部处理，核心不感知 |
| Feature flags | `feature('FLAG')` 直接调用 | 由 deps 实现内部处理，核心不感知 |
| 命令队列 | 直接操作 queue 函数 | `this.internal.drainQueue()` |
| Abort | `abortController.signal.aborted` | `this.abortSignal.aborted` |
| Token budget | `checkTokenBudget()` 直接调用 | `this.internal.checkTokenBudget()` |
| 消息边界获取 | 直接操作 `state.messages` | `this.state.messages` |
| 消息 yield | `yield msg` (松散联合类型) | `yield { type: 'message', message: msg }` |

**独立性验证**:
- AgentLoop.ts 不包含任何 `import ... from '../../src/...'`
- AgentLoop.ts 不包含任何 `import ... from 'bun:bundle'`
- AgentLoop.ts 不包含任何 `import React`
- 所有外部访问通过 `this.deps.*` 进行

**风险**: 高 — 核心路径，所有模式都经过这里
**依赖**: Phase 0 + Phase 1 + Phase 2

#### 4.10 创建 `packages/agent/core/AgentCore.ts` — 公共 API

**状态**: 新建

```typescript
export class AgentCore {
  private loop: AgentLoop
  private state: AgentState

  constructor(
    private deps: AgentDeps,
    initialState?: Partial<AgentState>,
  ) {}

  async *run(input: AgentInput): AsyncGenerator<AgentEvent> {
    // 初始化状态
    // 调用 loop.run(input)
    // yield 所有 AgentEvent
    // 最终 yield done 事件
  }

  interrupt(): void { /* ... */ }
  getMessages(): readonly Message[] { return this.state.messages }
  getState(): AgentState { return this.state }
  setModel(model: string): void { /* ... */ }
}
```

**风险**: 中
**依赖**: 4.9

---

### Phase 4: 桥接与迁移 [并行运行新旧路径]

#### 4.11 创建桥接 — `query.ts` 委托给 AgentLoop

**状态**: 改造现有文件
**工作**: 让 `query()` 函数内部委托给 `AgentLoop`，同时保持外部 API 不变。

```typescript
// src/query.ts 中:
import { AgentLoop } from '@anthropic/agent'
import { createProductionDeps } from './agent/createDeps.js'

export async function* query(params: QueryParams) {
  if (feature('AGENT_CORE')) {
    // 新路径：构建 AgentDeps，委托给 AgentLoop
    const deps = createProductionDeps(params.toolUseContext)
    const loop = new AgentLoop(deps)
    for await (const event of loop.run(toAgentInput(params))) {
      yield fromAgentEvent(event)  // 转换为旧的 yield 格式
    }
  } else {
    // 旧路径：原始 queryLoop
    yield* queryLoop(params)
  }
}
```

**验证策略**:
1. 先在测试中启用 `AGENT_CORE` flag，对比新旧路径的输出
2. 在 dev 模式下默认启用，收集日志
3. 确认所有测试通过后，移除旧路径

**风险**: 高 — 并行期间两套路径需要行为一致
**依赖**: 4.10

#### 4.12 重构 `QueryEngine` — 分离会话编排

**状态**: 改造现有文件
**工作**: 将 `QueryEngine` 的职责收窄为会话编排层，内部组合 `AgentCore`。

| 保留在 QueryEngine | 迁入 AgentCore |
|-------------------|---------------|
| 系统 prompt 构建 (`fetchSystemPromptParts`) | 核心消息循环 |
| 消息状态管理 (`mutableMessages`) | turn 级别状态 |
| SDK 消息转换 (`SDKMessage`) | — |
| 插件/技能加载 | — |
| 转录持久化 | 委托给 `deps.session` |
| `ask()` 便捷函数 | — |

改造后的 `QueryEngine`:

```typescript
import { AgentCore, AgentEvent } from '@anthropic/agent'
import { createProductionDeps } from './agent/createDeps.js'

class QueryEngine {
  private agent: AgentCore  // 组合而非继承

  constructor(config: QueryEngineConfig) {
    const deps = createProductionDeps(config.toolUseContext)
    this.agent = new AgentCore(deps)
  }

  async *submitMessage(prompt, options?) {
    // 1. 构建 system prompt
    // 2. 处理 slash commands
    // 3. 加载插件/技能
    // 4. 委托给 agent.run()
    for await (const event of this.agent.run(input)) {
      yield this.toSDKMessage(event)  // 转换为 SDK 格式
    }
  }
}
```

**风险**: 中 — 改动面大但逻辑清晰
**依赖**: 4.11

---

### Phase 5: 清理与独立 [移除旧代码，确认独立包]

#### 4.13 移除旧路径

**状态**: 删除/简化
**工作**: 移除 `query.ts` 中的旧 `queryLoop` 和 `feature('AGENT_CORE')` 分支。`query.ts` 退化为薄包装层。

```typescript
// src/query.ts — 最终形态
import { AgentLoop } from '@anthropic/agent'
import { createProductionDeps } from './agent/createDeps.js'

export async function* query(params: QueryParams) {
  const deps = createProductionDeps(params)
  const loop = new AgentLoop(deps)
  for await (const event of loop.run(toAgentInput(params))) {
    yield fromAgentEvent(event)
  }
}
```

**风险**: 中 — 需要确认所有路径已迁移
**依赖**: 4.12 在所有环境中验证通过

#### 4.14 验证 `packages/agent` 独立性

**状态**: 验证
**工作**: 确认 `packages/agent` 可以独立使用。

验证清单:
- [ ] `packages/agent` 不 import `src/` 中的任何文件
- [ ] `packages/agent` 不 import `bun:bundle`（feature flags）
- [ ] `packages/agent` 不 import React / Ink
- [ ] `packages/agent` 不 import `AppState` / `ToolUseContext`
- [ ] 所有外部依赖通过 `AgentDeps` 接口注入
- [ ] `bun test packages/agent/` 全部通过

**风险**: 低 — 纯验证
**依赖**: 4.13

---

## 五、实施顺序（依赖链）

```
Phase 0: 纯类型定义（无运行时影响）
  4.1 package.json ─┐
  4.2 events.ts ─────┤
  4.3 state.ts ──────┤
  4.4 deps.ts ───────┤
  4.5 index.ts ──────┘
                     │
Phase 1: 纯逻辑迁移   ▼
  4.6 internal/* ────┐
                     │
Phase 2: 适配器层     ▼ (可与 Phase 1 并行)
  4.7 deps impls ───┐
  4.8 createDeps ────┘
                     │
Phase 3: 核心迁移     ▼
  4.9 AgentLoop ─────┐
  4.10 AgentCore ─────┘
                     │
Phase 4: 桥接迁移     ▼
  4.11 bridge ───────┐
  4.12 QueryEngine ──┘
                     │
Phase 5: 清理独立     ▼
  4.13 移除旧路径 ───┐
  4.14 独立性验证 ────┘
```

每个 Phase 完成后运行 `bun test` 确认无回归。Phase 0–1 可以并行于其他 feature 的开发。

---

## 六、测试计划

### 测试独立性原则

`packages/agent/__tests__/` 中的所有测试：
- 只使用 `createMockDeps()` 创建依赖
- 不 import 任何 `src/` 模块
- 可独立运行: `bun test packages/agent/`

### mockDeps 标准工厂

```typescript
// packages/agent/__tests__/fixtures/mockDeps.ts
import { mock } from 'bun:test'
import type { AgentDeps } from '../../index.js'

export function createMockDeps(overrides?: Partial<AgentDeps>): AgentDeps {
  return {
    provider: {
      stream: mock(async function* () { /* 返回固定响应 */ }),
      getModel: mock(() => 'test-model'),
    },
    tools: {
      find: mock(() => undefined),
      execute: mock(async () => ({ output: 'ok' })),
    },
    permission: {
      canUseTool: mock(async () => ({ allowed: true })),
    },
    output: { emit: mock(() => {}) },
    hooks: {
      onTurnStart: mock(async () => {}),
      onTurnEnd: mock(async () => {}),
      onStop: mock(async () => ({ blockingErrors: [], preventContinuation: false })),
    },
    compaction: {
      maybeCompact: mock(async () => ({ compacted: false, messages: [] })),
    },
    context: {
      getSystemPrompt: mock(() => []),
      getUserContext: mock(() => ({})),
      getSystemContext: mock(() => ({})),
    },
    session: {
      recordTranscript: mock(async () => {}),
      getSessionId: mock(() => 'test-session'),
    },
    ...overrides,
  }
}
```

### 新增测试

| 优先级 | 测试文件 | 覆盖内容 |
|--------|---------|---------|
| P0 | `AgentLoop.test.ts` | 核心循环：单 turn、多 turn、maxTurns、interrupt、tool 执行、权限拒绝 |
| P0 | `AgentLoop.test.ts` | Compaction 触发条件、压缩前后消息一致性 |
| P0 | `AgentLoop.test.ts` | Abort 处理：中断时 pending tool_use 的 synthetic result |
| P1 | `AgentCore.test.ts` | 公共 API：run/interrupt/getMessages/setModel |
| P1 | `AgentCore.test.ts` | 状态管理：跨 turn 消息累积、usage 累计 |
| P2 | `mockDeps.ts` | 标准化 mock 工厂，记录所有调用 |

### 集成测试 (在主包中)

| 优先级 | 测试文件 | 覆盖内容 |
|--------|---------|---------|
| P1 | `src/agent/__tests__/integration.test.ts` | createProductionDeps 构建完整性 |
| P2 | `src/agent/__tests__/integration.test.ts` | 真实 ProviderDepImpl 调用 API |
| P2 | `src/agent/__tests__/integration.test.ts` | 真实 CompactionDepImpl 压缩流程 |

---

## 七、风险

### 高风险

| 风险 | 影响 | 缓解 |
|------|------|------|
| 核心循环是所有路径的瓶颈，重构导致回归 | 所有功能受影响 | Phase 4 并行运行新旧路径；feature flag 控制；全量测试 |
| `ToolUseContext` 40+ 字段逐一迁移 | 漏迁移导致运行时错误 | 适配器模式：先 delegate 全部字段，再逐步替换 |
| `PermissionDepImpl` 桥接 React hook | React 生命周期与 async 函数不匹配 | PermissionDepImpl 持有 hook 返回的回调引用，不直接使用 hook |

### 中风险

| 风险 | 影响 | 缓解 |
|------|------|------|
| Feature flag 分支散布在循环中 | 行为差异隐藏在 flag 后 | 每个 flag 分支在适配器内部处理，核心循环不感知 flag |
| 5 种 compaction 策略统一为一个接口 | 策略组合逻辑复杂 | `CompactionDepImpl` 内部保持现有策略调用链，只暴露 `maybeCompact()` |
| `stopHooks.ts` 474 行逻辑迁入 HookDep | hook 执行与核心循环耦合深 | HookDepImpl 先包装现有 `handleStopHooks`，Phase 5 再精简 |

### 低风险

| 风险 | 影响 | 缓解 |
|------|------|------|
| Message 类型宽泛导致类型不安全 | 运行时正确但类型检查不严 | 核心层定义 `CoreMessage` 严格子集，边界转换 |
| `query/deps.ts` 已有 DI 模式与新 DI 冲突 | 两套 DI 并存 | Phase 3 完成后统一到 AgentDeps，移除 QueryDeps |

---

## 八、验收标准

### 包独立性

- [ ] `packages/agent` 可独立 import，不依赖 `src/`、React、Ink、AppState、`bun:bundle`
- [ ] `packages/agent/package.json` 正确配置为 workspace 包
- [ ] `bun test packages/agent/` 可独立运行且全部通过

### 通信契约

- [ ] `AgentCore.run()` 返回 `AsyncGenerator<AgentEvent>`，所有事件类型有明确 type 字段
- [ ] `AgentDeps` 8 个子接口均有实现，覆盖 REPL/SDK/Bridge/Swarm 四种消费者
- [ ] 主包中的适配器 (`src/agent/`) 是唯一同时 import `packages/agent` 和 `src/` 的地方
- [ ] 核心循环中不存在 `import ... from 'src/...'` 或 `import ... from 'bun:bundle'`

### 功能完整性

- [ ] `bun test` 全量通过（无回归）
- [ ] `query.ts` 退化为 < 50 行的薄包装层
- [ ] `QueryEngine` 不再直接调用 `queryModelWithStreaming`、`runTools`、`handleStopHooks`
- [ ] REPL/SDK/Bridge 三种消费模式行为与迁移前一致

### 测试覆盖

- [ ] `packages/agent/` 测试覆盖率 > 80%
- [ ] 核心循环的单元测试覆盖：单 turn、多 turn、maxTurns、interrupt、tool 执行、权限拒绝、abort、compaction
- [ ] 集成测试验证真实适配器行为

---

## 九、不在范围内

- **Message 类型重构** — 定义 `CoreMessage` 严格子集是可选项，不阻塞核心循环迁移
- **feature-provider / feature-tool-registry 等上游 feature 的实现** — 本计划只定义 AgentDeps 接口和桥接适配器
- **Swarm 多 agent 协调** — 消费 AgentCore，但不在此计划内实现
- **SDK / Bridge 适配器** — 同上，消费者自行实现
- **性能优化** — 迁移不改变运行时性能特征
