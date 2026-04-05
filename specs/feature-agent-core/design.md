# Agent Core 设计

> 来源: V6.md 四 4.11 (compaction), feature-overview Phase 3 (packages/agent), query.ts / QueryEngine.ts 抽象
> 优先级: P1
> 风险: 高

## 核心原则：包独立与通信边界

`packages/agent` 是一个**完全独立**的包，与主 CLI 包 (`src/`) 之间**零运行时依赖**。所有外部能力通过依赖注入 (`AgentDeps`) 传入，核心循环内部不 import 任何 `src/` 模块。

```text
┌─────────────────────────────────────────────────────────────────┐
│                        packages/agent                            │
│                     (独立包，零外部运行时依赖)                     │
│                                                                  │
│  ┌─── 通信契约 ───────────────────────────────────────────────┐ │
│  │                                                             │ │
│  │  入口 (Inbound)                                             │ │
│  │  ├─ AgentCore.run(AgentInput)   ← 消费者调用               │ │
│  │  ├─ AgentCore.interrupt()       ← 外部中断                 │ │
│  │  └─ AgentDeps (构造时注入)      ← 所有外部能力的接口        │ │
│  │                                                             │ │
│  │  出口 (Outbound)                                            │ │
│  │  ├─ AsyncGenerator<AgentEvent>  ← 统一事件流 (唯一输出)    │ │
│  │  └─ AgentState (查询)           ← 状态快照 (只读)          │ │
│  │                                                             │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  ┌─── 禁止事项 ───────────────────────────────────────────────┐ │
│  │                                                             │ │
│  │  ✗ 不 import src/ 下任何文件                                │ │
│  │  ✗ 不 import React / Ink                                    │ │
│  │  ✗ 不 import bun:bundle (feature flags)                     │ │
│  │  ✗ 不 import AppState / ToolUseContext                      │ │
│  │  ✗ 不直接操作 DOM / terminal / 文件系统                     │ │
│  │  ✗ 不持有任何全局单例或可变外部引用                          │ │
│  │                                                             │ │
│  └─────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

---

## 架构全景

```text
┌───────────────────────────────────────────────────────────────────┐
│                    packages/agent                                 │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │  AgentCore 接口                                             │  │
│  │  ├─ run(prompt, options)       → AsyncGenerator<AgentEvent>│  │
│  │  ├─ interrupt()                → void                     │  │
│  │  ├─ getMessages()              → readonly Message[]       │  │
│  │  ├─ getState()                 → AgentState               │  │
│  │  └─ setModel(model)           → void                     │  │
│  └──────────────────────┬────────────────────────────────────┘  │
│                          │                                       │
│  ┌───────────────────────┼───────────────────────────────────┐  │
│  │  AgentDeps (依赖注入)  │                                   │  │
│  │                       │                                   │  │
│  │  ┌──────────────┐ ┌───▼──────────┐ ┌───────────────────┐ │  │
│  │  │ Provider     │ │ ToolRegistry │ │ PermissionGate    │ │  │
│  │  │ (LLM 调用)   │ │ (工具执行)    │ │ (权限决策)        │ │  │
│  │  └──────────────┘ └──────────────┘ └───────────────────┘ │  │
│  │                                                       │  │  │
│  │  ┌──────────────┐ ┌──────────────┐ ┌──────────────────┐│  │  │
│  │  │ OutputTarget │ │ HookLifecycle│ │ CompactionPipeline││  │  │
│  │  │ (输出渲染)   │ │ (钩子回调)    │ │ (上下文压缩)      ││  │  │
│  │  └──────────────┘ └──────────────┘ └──────────────────┘│  │  │
│  └─────────────────────────────────────────────────────────┘  │
│                          │                                       │
│  ┌───────────────────────▼───────────────────────────────────┐  │
│  │  Turn Loop (核心循环)                                      │  │
│  │                                                            │  │
│  │  1. 构建上下文 (systemPrompt + messages + context)          │  │
│  │  2. 调用 LLM (deps.provider.stream())                      │  │
│  │  3. yield AssistantMessage / StreamEvent                   │  │
│  │  4. 收集 tool_use blocks                                   │  │
│  │  5. 权限检查 (deps.permission.canUseTool())                │  │
│  │  6. 执行工具 (deps.toolRegistry.execute())                 │  │
│  │  7. yield ToolResult                                       │  │
│  │  8. 压缩检查 (deps.compaction.maybeCompact())              │  │
│  │  9. 继续 → 1                                               │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │  AgentEvent (统一事件流 — 唯一的输出契约)                    │  │
│  │  ├─ { type: 'message', message: Message }                  │  │
│  │  ├─ { type: 'tool_start', toolUseId, toolName, input }     │  │
│  │  ├─ { type: 'tool_progress', toolUseId, progress }         │  │
│  │  ├─ { type: 'tool_result', toolUseId, result }             │  │
│  │  ├─ { type: 'permission_request', tool, result → Promise } │  │
│  │  ├─ { type: 'compaction', before, after }                  │  │
│  │  └─ { type: 'done', reason: 'end_turn' | 'max_turns' | 'interrupted' | 'error' }│
│  └─────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────┘

                         消费者 (在主包 src/ 中)
         ┌───────────────┬───────────────────┐
         │               │                   │
  ┌──────▼──────┐ ┌──────▼──────┐  ┌────────▼───────┐
  │  CLI REPL   │ │  SDK / API  │  │  Bridge / RC   │
  │  (Ink 渲染) │ │  (JSON 流)  │  │  (远程控制)    │
  └─────────────┘ └─────────────┘  └────────────────┘
         │               │                   │
         └───────────────┼───────────────────┘
                         │
                ┌────────▼────────┐
                │   Swarm 调度器   │
                │ (多 agent 协作)  │
                └─────────────────┘
```

---

## 通信原则

### 1. 依赖倒置原则 (DIP)

`packages/agent` 定义接口，主包 (`src/`) 提供实现：

```text
packages/agent 定义:
  AgentDeps.provider    → ProviderDep 接口
  AgentDeps.tools       → ToolDep 接口
  AgentDeps.permission  → PermissionDep 接口
  AgentDeps.output      → OutputDep 接口
  AgentDeps.hooks       → HookDep 接口
  AgentDeps.compaction  → CompactionDep 接口
  AgentDeps.context     → ContextDep 接口
  AgentDeps.session     → SessionDep 接口

src/ (主包) 提供:
  ProviderDepImpl       → 包装 services/api/claude.ts
  ToolDepImpl           → 包装 tools/registry/ToolRegistry.ts + toolExecution.ts
  PermissionDepImpl     → 包装 hooks/useCanUseTool.tsx + permissions pipeline
  OutputDepImpl         → 包装 Ink 渲染 / JSON 流 / 静默输出
  HookDepImpl           → 包装 utils/hooks.ts + query/stopHooks.ts
  CompactionDepImpl     → 包装 services/compact/ (5种策略)
  ContextDepImpl        → 包装 context.ts + systemPrompt
  SessionDepImpl        → 包装 sessionStorage + bootstrap/state.ts
```

### 2. 单向数据流

```text
消费者 ──AgentInput──→ AgentCore.run() ──AgentEvent[]──→ 消费者
         (输入)         (核心循环)         (事件流)

AgentDeps ──构造时注入──→ AgentCore (只读持有)
           (一次性绑定，运行时不可变)
```

- **入**: `AgentInput` (prompt + messages + options) + `AgentDeps` (构造时注入)
- **出**: `AsyncGenerator<AgentEvent>` (唯一输出通道)
- **禁止**: 核心循环不持有任何外部可变引用，不回调消费者方法

### 3. 事件驱动通信

核心循环与外部世界的唯一通信方式是通过 `AgentEvent` 事件流。消费者通过消费此事件流来驱动 UI / 日志 / 持久化等行为。

```typescript
// 消费者消费事件流的标准模式
const agent = new AgentCore(deps)
for await (const event of agent.run(input)) {
  switch (event.type) {
    case 'message':         renderMessage(event.message); break
    case 'tool_start':      showToolProgress(event.toolName); break
    case 'tool_progress':   updateProgress(event.toolUseId, event.progress); break
    case 'tool_result':     showResult(event.result); break
    case 'permission_request': promptUser(event.tool, event.input); break
    case 'compaction':      handleCompaction(event.before, event.after); break
    case 'done':            handleDone(event.reason); break
  }
}
```

### 4. 类型边界

`packages/agent` 内部定义自己需要的类型子集，不依赖主包的类型：

| 类型 | 定义位置 | 说明 |
|------|---------|------|
| `AgentEvent` | `packages/agent/types/events.ts` | 核心事件联合类型 |
| `AgentState` | `packages/agent/types/state.ts` | 核心状态严格子集 |
| `AgentInput` | `packages/agent/types/state.ts` | 运行时输入 |
| `AgentDeps` | `packages/agent/types/deps.ts` | 依赖注入接口 |
| `DoneReason` | `packages/agent/types/events.ts` | 终止原因枚举 |
| `Message` | 共享类型或 `packages/agent/types/messages.ts` | 核心层使用的消息子集 |
| `Tool`, `ToolResult` | 共享类型或 `packages/agent/types/tools.ts` | 工具相关类型 |
| `Usage` | 共享类型 | Token 使用统计 |

**共享类型策略**: `Message`、`Tool`、`Usage` 等跨包共享的类型，可以：
- (A) 在 `packages/agent/types/` 中定义严格子集 `CoreMessage`、`CoreTool`，边界处转换
- (B) 抽取到 `packages/shared-types/` 独立包
- (C) 由 `packages/agent` 导出接口，主包适配实现

推荐先采用 (A) 方案（最小改动），后续视需要迁移到 (B)。

### 5. 错误边界

```text
核心循环内部错误:
  → yield { type: 'done', reason: 'error' } 终止循环
  → 消费者通过 done 事件获知错误，自行处理

Deps 调用错误:
  → ProviderDep.stream() 抛出 API 错误 → 核心循环 catch，yield error done
  → ToolDep.execute() 抛出执行错误 → 包装为 ToolResult (isError: true)，不终止循环
  → PermissionDep.canUseTool() 拒绝 → 跳过工具执行，yield permission denied 结果
  → CompactionDep.maybeCompact() 失败 → 降级为不压缩，继续循环
  → HookDep.onStop() 阻止继续 → yield done (reason: 'stop_hook')
```

---

## 当前问题

### query.ts 核心循环的耦合

`query()` 函数是整个系统的核心——消息循环、LLM 调用、工具执行、compaction 策略全在此文件中。但它与大量外部模块直接耦合：

| 耦合类别 | 当前依赖 | 耦合程度 |
|----------|---------|---------|
| API 调用 | `queryModelWithStreaming` 直接 import | 高 |
| Compaction | 5 种策略直接 import (auto, micro, snip, reactive, contextCollapse) | 高 |
| 工具执行 | `StreamingToolExecutor`, `runTools` 直接 import | 中 |
| 权限 | `CanUseToolFn` 来自 React hook | 高 |
| 全局状态 | `AppState` 通过 `toolUseContext.getAppState()` 访问 | 高 |
| Feature flags | ~10 个 `feature()` 调用控制核心路径 | 高 |
| 分析日志 | `logEvent` 散布在循环各处 | 中 |
| Session | `recordTranscript`, `sessionStorage` | 中 |

### ToolUseContext 巨型上下文

`ToolUseContext` 约 300 行类型定义、40+ 字段，横跨 UI（`setToolJSX`）、状态管理（`getAppState`/`setAppState`）、工具、权限、MCP、compaction、文件历史、归因等。这是核心循环与外部世界的单一耦合点。

**拆分策略**: 将 `ToolUseContext` 的 40+ 字段按域分组，映射到 `AgentDeps` 的 8 个子接口：

| ToolUseContext 字段域 | 映射到 AgentDeps |
|----------------------|-----------------|
| `options.tools`, `options.model` | `AgentDeps.tools`, `AgentDeps.provider.getModel()` |
| `getAppState()`, `setAppState()` | 由消费者通过事件流管理，核心不直接访问 |
| `setToolJSX`, `addNotification` | `AgentDeps.output` |
| `abortController` | `AgentInput.abortSignal` |
| `handleElicitation` | `AgentDeps.permission` |
| `updateFileHistoryState` | `AgentDeps.hooks.onTurnEnd()` |
| `agentId`, `agentType`, `preserveToolUseResults` | `AgentState` 内部字段 |
| `contentReplacementState` | `AgentDeps.compaction` |

### QueryEngine 会话管理耦合

`QueryEngine` 封装了 `query()`，但混入了：
- 系统 prompt 构建（`fetchSystemPromptParts`）
- SDK 消息转换（`SDKMessage` 等）
- UI 组件引用（`MessageSelector`）
- 会话持久化（`recordTranscript`）
- 插件/技能加载

### Message 类型宽泛

`Message` 类型使用 index signature + 大量 optional 字段，子类型通过 intersection + literal `type` 区分，不是严格的可辨识联合。核心循环需要频繁类型断言。

---

## 改动范围

### Phase 1: 定义核心接口 (纯类型，不改运行时代码)

1. **`AgentCore` 接口** — agent 的公共 API，消费者（REPL/SDK/Bridge/Swarm）只依赖此接口
2. **`AgentDeps` 接口** — 所有外部依赖的注入点，替代当前 `ToolUseContext` + `QueryDeps` 的组合
3. **`AgentEvent` 联合类型** — 统一事件流，替代当前 `StreamEvent | RequestStartEvent | Message | TombstoneMessage | ToolUseSummaryMessage` 的松散联合
4. **`AgentState` 接口** — 核心状态的严格子集（turnCount, usage, messages），替代当前对 `AppState` 的直接访问

### Phase 2: 抽象核心循环

将 `query()` 的 while-true 循环重构为 `packages/agent` 中的 `AgentLoop` 类：

```typescript
class AgentLoop {
  constructor(private deps: AgentDeps) {}

  async *run(input: AgentInput): AsyncGenerator<AgentEvent> {
    // 原始 query() 的核心循环逻辑
    // 所有外部依赖通过 this.deps 访问
    // 不再直接 import 任何 UI / 状态 / 分析模块
  }
}
```

关键改动：
- `deps.provider.stream()` 替代直接 `queryModelWithStreaming` import
- `deps.compaction.maybeCompact()` 替代 5 个 compaction 策略的直接调用
- `deps.permission.canUseTool()` 替代 React hook 回调
- `deps.tools.execute()` 替代 `StreamingToolExecutor` / `runTools` 直接 import
- `deps.output.emit()` 替代散落在循环中的 side-effect
- `deps.hooks.onStop()` 替代 `handleStopHooks` 直接 import
- Feature flag 分支由 deps 实现内部处理，核心循环不感知 flag

### Phase 3: 重构 QueryEngine

将 `QueryEngine` 拆为两层：

```
┌──────────────────────────────────┐
│  QueryEngine (会话编排层)         │
│  (留在 src/，是 packages/agent   │
│   的消费者)                      │
│  - 消息持久化                     │
│  - 系统构建                       │
│  - SDK 消息转换                   │
│  - 插件/技能加载                  │
│  - 组装 AgentDeps                │
│  └──────────┬───────────────────┘
│             │ uses               │
│  ┌──────────▼───────────────────┐
│  │  AgentCore (核心循环)         │
│  │  (在 packages/agent 中)       │
│  │  - 纯逻辑，无 UI 依赖         │
│  │  - 可独立测试                 │
│  │  - 可独立用于 SDK/Bridge/Swarm│
│  └──────────────────────────────┘
```

### Phase 4: 提取为 packages/agent

文件结构：

```
packages/agent/
├── package.json              # { name: "@anthropic/agent", private: true }
├── index.ts                  # 公共导出
├── core/
│   ├── AgentCore.ts          # AgentCore 接口实现
│   ├── AgentLoop.ts          # 核心循环 (from query.ts)
│   └── state.ts              # AgentState, TurnState 内部状态管理
├── types/
│   ├── deps.ts               # AgentDeps 接口定义
│   ├── events.ts             # AgentEvent 联合类型
│   ├── state.ts              # AgentState, AgentInput 公共类型
│   └── messages.ts           # CoreMessage 严格子集（核心层使用的消息类型）
├── deps/                     # 适配器接口定义（实现留在 src/）
│   └── (仅接口，不含实现)
└── __tests__/
    ├── AgentLoop.test.ts     # 纯逻辑测试，所有 deps mock
    └── integration.test.ts   # 与真实 deps 的集成测试
```

---

## AgentDeps 详细设计

```typescript
interface AgentDeps {
  /** LLM 提供者 — 封装 API 调用和流处理
   *  实现: ProviderDepImpl → 委托到 ProviderRegistry (services/api/provider/) */
  provider: {
    stream(params: ProviderStreamParams): AsyncIterable<ProviderEvent>;
    getModel(): string;
  };

  /** 工具注册表 — 查找和执行工具
   *  实现: ToolDepImpl → 委托到 ToolRegistry (tools/registry/ToolRegistry.ts) */
  tools: {
    find(name: string): Tool | undefined;
    execute(tool: Tool, input: unknown, context: ToolExecContext): Promise<ToolResult>;
  };

  /** 权限门控 — 决定工具是否允许执行
   *  实现: PermissionDepImpl → 委托到 permissions pipeline (utils/permissions/) */
  permission: {
    canUseTool(tool: Tool, input: unknown, context: PermissionContext): Promise<PermissionResult>;
  };

  /** 输出目标 — 渲染消息和进度
   *  实现: OutputDepImpl → Ink 渲染 / JSON 流 / 静默输出 */
  output: {
    emit(event: AgentEvent): void;
  };

  /** 钩子生命周期 — 执行前后回调
   *  实现: HookDepImpl → 委托到模块化 hooks (utils/hooks/events/) */
  hooks: {
    onTurnStart(state: AgentState): Promise<void>;
    onTurnEnd(state: AgentState): Promise<void>;
    onStop(messages: Message[], context: StopHookContext): Promise<StopHookResult>;
  };

  /** 上下文压缩 — 管理对话长度
   *  实现: CompactionDepImpl → 委托到 services/compact/ */
  compaction: {
    maybeCompact(messages: Message[], tokenCount: number): Promise<CompactionResult>;
  };

  /** 系统上下文 — 提供系统 prompt 和环境信息
   *  实现: ContextDepImpl → 委托到 context.ts + systemPrompt */
  context: {
    getSystemPrompt(): SystemPrompt;
    getUserContext(): Record<string, string>;
    getSystemContext(): Record<string, string>;
  };

  /** 会话存储 — 转录和状态持久化
   *  实现: SessionDepImpl → 委托到 sessionStorage + bootstrap/state.ts */
  session: {
    recordTranscript(messages: Message[]): Promise<void>;
    getSessionId(): string;
  };
}
```

---

## 包间通信协议总结

```text
┌─────────────────────────────────────────────────────────────────┐
│                    packages/agent (独立包)                       │
│                                                                 │
│   公共 API:                                                     │
│   ├─ new AgentCore(deps: AgentDeps)                            │
│   ├─ agent.run(input: AgentInput) → AsyncGenerator<AgentEvent> │
│   ├─ agent.interrupt() → void                                  │
│   ├─ agent.getMessages() → readonly Message[]                  │
│   ├─ agent.getState() → AgentState                             │
│   └─ agent.setModel(model: string) → void                      │
│                                                                 │
│   依赖注入 (AgentDeps):                                         │
│   ├─ provider: ProviderDep     ← feature-provider 提供         │
│   ├─ tools: ToolDep            ← feature-tool-registry 提供    │
│   ├─ permission: PermissionDep ← feature-permission 提供       │
│   ├─ output: OutputDep         ← feature-output-target 提供    │
│   ├─ hooks: HookDep            ← feature-hook-lifecycle 提供   │
│   ├─ compaction: CompactionDep ← feature-compaction 提供       │
│   ├─ context: ContextDep       ← feature-context-pipeline 提供 │
│   └─ session: SessionDep       ← feature-storage 提供          │
│                                                                 │
│   独立性约束:                                                    │
│   ├─ 零 import from src/                                       │
│   ├─ 零 import from React / Ink                                │
│   ├─ 零 import from bun:bundle                                 │
│   ├─ 所有外部能力通过 AgentDeps 接口                            │
│   └─ 所有输出通过 AsyncGenerator<AgentEvent>                    │
└─────────────────────────────────────────────────────────────────┘

        ↑ 构造时注入 AgentDeps    ↓ 产出 AsyncGenerator<AgentEvent>

┌─────────────────────────────────────────────────────────────────┐
│                    src/ (主包 — 消费者)                          │
│                                                                 │
│   消费者:                                                       │
│   ├─ REPL.tsx         → 注入 Ink 渲染 + React 权限 UI          │
│   ├─ QueryEngine.ts   → 注入 SDK 输出 + 会话持久化              │
│   ├─ bridge/          → 注入 Bridge 输出 + 远程权限回调          │
│   └─ (未来) swarm/    → 注入 Silent 输出 + 自动权限策略          │
│                                                                 │
│   Deps 实现工厂:                                                │
│   └─ createProductionDeps(toolUseContext) → AgentDeps           │
│       ├─ ProviderDepImpl    → 委托 ProviderRegistry (已实现)     │
│       ├─ ToolDepImpl        → 委托 ToolRegistry (已实现)         │
│       ├─ PermissionDepImpl  → 委托 permissions pipeline          │
│       ├─ OutputDepImpl      → 包装 Ink / JSON / Silent 渲染     │
│       ├─ HookDepImpl        → 委托模块化 hooks (已实现)          │
│       ├─ CompactionDepImpl  → 委托 services/compact/*           │
│       ├─ ContextDepImpl     → 委托 context.ts + systemPrompt    │
│       └─ SessionDepImpl     → 委托 sessionStorage + state.ts    │
└─────────────────────────────────────────────────────────────────┘
```

### 依赖方向

```text
packages/agent          ← 零运行时依赖 (纯核心逻辑 + 接口定义)
packages/agent          → 仅依赖注入接口 (AgentDeps 中的各接口)

packages/agent 的消费者 (依赖 packages/agent):
  src/screens/REPL.tsx     ← 注入 Ink 输出 + React 权限 UI
  src/QueryEngine.ts       ← 注入 SDK 输出 + 会话持久化
  src/bridge/              ← 注入 Bridge 输出 + 远程权限回调
  packages/swarm/          ← 注入 Silent 输出 + 自动权限策略

packages/agent 依赖的接口由以下模块提供实现:
  services/api/             → AgentDeps.provider (via ProviderDepImpl)
  tools/registry/           → AgentDeps.tools (via ToolDepImpl)
  hooks/useCanUseTool.tsx   → AgentDeps.permission (via PermissionDepImpl)
  components/               → AgentDeps.output (via OutputDepImpl)
  utils/hooks.ts            → AgentDeps.hooks (via HookDepImpl)
  services/compact/         → AgentDeps.compaction (via CompactionDepImpl)
  context.ts                → AgentDeps.context (via ContextDepImpl)
  services/storage/         → AgentDeps.session (via SessionDepImpl)
```

### 测试边界

```text
packages/agent/__tests__/:
  ├─ 所有测试仅使用 createMockDeps()，不 import 任何 src/ 模块
  ├─ AgentLoop.test.ts  → mock 全部 deps，验证核心循环逻辑
  ├─ AgentCore.test.ts  → mock 全部 deps，验证公共 API
  └─ 可独立运行: bun test packages/agent/ 无需主包环境

src/__tests__/ (主包集成测试):
  └─ agent-integration.test.ts → 使用 createProductionDeps()，验证真实适配器
```

---

## 与其他 Feature 的关系

| Feature | 关系 | 实现状态 | 说明 |
|---------|------|---------|------|
| feature-provider | 上游 | **已实现** (be53008) | `ProviderAdapter` + `ProviderRegistry` + `AuthProvider` — 提供 `AgentDeps.provider` |
| feature-tool-registry | 上游 | **已实现** (75f4962) | `ToolRegistry` + 4 种 `ToolProvider` — 提供 `AgentDeps.tools` |
| feature-hook-lifecycle | 上游 | **已实现** (2853ea3) | 薄代理层 re-export — 提供 `AgentDeps.hooks` |
| feature-permission | 上游 | 未实现 | 提供 `AgentDeps.permission` |
| feature-output-target | 上游 | 未实现 | 提供 `AgentDeps.output` |
| feature-compaction | 上游 | 未实现 | 提供 `AgentDeps.compaction` |
| feature-context-pipeline | 上游 | 未实现 | 提供 `AgentDeps.context` |
| feature-storage | 上游 | 未实现 | 提供 `AgentDeps.session` |
| feature-shell | 下游 | — | BashTool 通过 `AgentDeps.tools` 被调用 |
| feature-swarm | 下游 | — | 创建多个 AgentCore 实例协调工作 |
| feature-overview | 包含 | — | Phase 3 的 `packages/agent` 即为此 feature |

### 已实现模块的接口对齐

#### Provider/Auth (be53008)

`src/services/api/provider/` 已实现完整的 ProviderAdapter 体系：

```text
ProviderAdapter 接口:
  queryStreaming(params: QueryParams): AsyncGenerator<StreamEvent | AssistantMessage>
  query(params: QueryParams): Promise<BetaMessage>
  isAvailable(): boolean
  readonly capabilities: ProviderCapabilities

ProviderRegistry:
  registerProvider(adapter: ProviderAdapter): void
  getProvider(name?: string): ProviderAdapter
  queryWithProvider(params: QueryParams): AsyncGenerator<...>

AuthProvider 接口:
  getCredentials(): Promise<AuthCredentials>
  refresh(): Promise<void>
  isAuthenticated(): boolean
  invalidate(): void
```

`AgentDeps.provider` 适配器 (`ProviderDepImpl`) 应委托到 `ProviderRegistry.queryWithProvider()`，而非直接 import `claude.ts`。

#### ToolRegistry (75f4962)

`src/tools/registry/ToolRegistry.ts` 已实现完整的注册中心：

```text
ToolRegistry 类:
  register(tool, category, providerName): void
  unregister(name): boolean
  registerProvider(provider: ToolProvider): Promise<void>
  get(name): Tool | undefined              // 含 alias 解析
  getAll(): Tools
  getEnabledTools(permissionContext): Tools
  assemblePool(permissionContext, mcpTools): Tools
  filterByDenyRules(tools, permissionContext): Tools
  has(name): boolean
  clear(): void
  readonly size: number
```

`AgentDeps.tools` 适配器 (`ToolDepImpl`) 应委托到 `ToolRegistry` 实例，不再直接 import `tools.ts`。

#### Hook Lifecycle (2853ea3)

`src/utils/hooks/` 已模块化为薄代理层：

```text
events/toolEvents.ts:       executePreToolHooks, executePostToolHooks, ...
events/sessionEvents.ts:    executeSessionStartHooks, executeSessionEndHooks, executeStopHooks, ...
events/compactEvents.ts:    executePreCompactHooks, executePostCompactHooks
events/agentEvents.ts:      executeSubagentStartHooks, executeSubagentStopHooks
events/permissionEvents.ts: executePermissionRequestHooks, executeElicitationHooks, ...
core/executor.ts:           createBaseHookInput, hasBlockingResult, ...
core/types.ts:              HookResult, AggregatedHookResult, ...
```

`AgentDeps.hooks` 适配器 (`HookDepImpl`) 应委托到这些模块化的 hook 函数，而非直接 import `hooks.ts` 单体文件。

---

## 风险与缓解

| 风险 | 缓解策略 |
|------|---------|
| 核心循环重构影响所有路径 | Phase 1 先定义接口不改代码；Phase 2 保留旧代码并行运行 |
| `ToolUseContext` 40+ 字段迁移困难 | 逐字段迁移到 `AgentDeps` 子接口，旧字段先 delegate |
| Feature flag 分支硬编码 | 策略模式：不同 flag 组合 = 不同 deps 实现，核心不感知 flag |
| `Message` 类型过于宽泛 | 核心层定义严格的 `CoreMessage` 联合类型，边界处转换 |
| 重构期间 CI 回归 | 每个 Phase 完成后跑全量测试，保持 `query.ts` 作为 fallback |
| React hook 桥接复杂 | `PermissionDepImpl` 持有 hook 返回的回调引用，不直接使用 hook |
