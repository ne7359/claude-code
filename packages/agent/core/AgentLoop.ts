// AgentLoop — 核心消息循环
// 从 src/query.ts 的 while-true 循环迁移而来
// 所有外部依赖通过 deps 访问，不直接 import 任何 src/ 模块

import type { AgentDeps, ProviderEvent, ProviderStreamParams } from '../types/deps.js'
import type { AgentEvent, DoneReason } from '../types/events.js'
import type { AgentInput, TurnState } from '../types/state.js'
import type {
  CoreMessage,
  CoreAssistantMessage,
  CoreUserMessage,
  CoreContentBlock,
  Usage,
} from '../types/messages.js'
import type { CoreTool, ToolResult } from '../types/tools.js'
import { createBudgetTracker, checkTokenBudget } from '../internal/tokenBudget.js'
import { createSyntheticToolResults, shouldAbort } from '../internal/abort.js'

export class AgentLoop {
  constructor(private deps: AgentDeps) {}

  /**
   * 核心循环入口
   *
   * 循环步骤:
   * 1. 构建上下文 (systemPrompt + messages + context)
   * 2. 调用 LLM (deps.provider.stream())
   * 3. yield MessageEvent / StreamEvent
   * 4. 收集 tool_use blocks
   * 5. 权限检查 (deps.permission.canUseTool())
   * 6. 执行工具 (deps.tools.execute())
   * 7. yield ToolResultEvent
   * 8. 压缩检查 (deps.compaction.maybeCompact())
   * 9. 继续 → 1
   */
  async *run(input: AgentInput): AsyncGenerator<AgentEvent> {
    const maxTurns = input.maxTurns ?? Infinity
    const budget = input.tokenBudget ?? null
    const abortSignal = input.abortSignal
    let messages: CoreMessage[] = [...input.messages]
    let turnCount = 0
    const budgetTracker = createBudgetTracker()

    // 如果有 prompt，构建初始用户消息
    if (input.prompt) {
      const userMsg = this.createUserMessage(input.prompt, input.attachments)
      messages = [...messages, userMsg]
    }

    // 主循环
    while (turnCount < maxTurns) {
      // 检查中断
      if (shouldAbort(abortSignal)) {
        yield { type: 'done', reason: 'interrupted' as DoneReason }
        return
      }

      // --- Step 1: 构建上下文 ---
      const systemPrompt = this.deps.context.getSystemPrompt()
      const userContext = this.deps.context.getUserContext()
      const systemContext = this.deps.context.getSystemContext()

      // --- Step 2: 调用 LLM ---
      const tools = this.collectTools()
      const streamParams: ProviderStreamParams = {
        systemPrompt,
        messages,
        tools,
        model: this.deps.provider.getModel(),
        maxTokens: undefined,
        temperature: undefined,
        abortSignal,
        ...userContext,
        ...systemContext,
      }

      yield { type: 'request_start', params: streamParams }

      let assistantMessage: CoreAssistantMessage | null = null
      let streamError: unknown = null

      try {
        const stream = this.deps.provider.stream(streamParams)
        const turnState: TurnState = {
          pendingToolUses: [],
          textBlocks: [],
          currentTextBlockIndex: -1,
          thinkingBlocks: [],
          currentThinkingBlockIndex: -1,
          turnUsage: { input_tokens: 0, output_tokens: 0 },
          stoppedByHook: false,
        }

        for await (const event of stream) {
          const eventType = (event as any).type
          // queryModel 同时 yield { type: 'stream_event', event } 和 { type: 'assistant', message }
          // 区分处理：assistant → message，stream_event → stream，其他也归为 stream
          if (eventType === 'assistant') {
            // queryModel 构建的完整 assistant message（每 content_block_stop 一个）
            assistantMessage = event as unknown as CoreAssistantMessage
            yield { type: 'message', message: assistantMessage }
          } else if (eventType === 'system') {
            // API 错误消息等
            yield { type: 'message', message: event as unknown as CoreMessage }
          } else {
            // stream_event 或原始 SDK 流事件
            yield { type: 'stream', event }
            // processStreamEvent 期望原始 SDK 事件（message_start, content_block_delta 等）
            // queryModel 包装为 { type: 'stream_event', event: rawSDKEvent }，需要解包
            const rawEvent = eventType === 'stream_event'
              ? (event as any).event
              : event
            this.processStreamEvent(rawEvent, turnState)
          }
        }

        // Fallback: 如果 provider 只 yield 了原始事件（没有构建好的 assistant message），
        // 自己构建一个（兼容纯 mock 场景）
        if (!assistantMessage) {
          assistantMessage = this.buildAssistantMessage(turnState)
          if (assistantMessage.content.length > 0 || turnState.stopReason) {
            yield { type: 'message', message: assistantMessage }
          }
        }
      } catch (error) {
        streamError = error
      }

      // 处理流错误
      if (streamError !== null) {
        yield { type: 'done', reason: 'error' as DoneReason, error: streamError }
        return
      }

      // 将最后的 assistant message 加入消息列表（用于 tool_use 提取和上下文追踪）
      if (assistantMessage) {
        messages = [...messages, assistantMessage]
      }

      turnCount++
      // 兼容两种格式：扁平 CoreMessage.stop_reason 和嵌套 Message.message.stop_reason
      const rawAsst = assistantMessage as any
      const stopReason: string | null | undefined = rawAsst?.stop_reason ?? rawAsst?.message?.stop_reason ?? null
      if (stopReason !== 'tool_use') {
        // LLM 决定停止 — 检查 token budget 是否需要续写
        const budgetDecision = checkTokenBudget(
          budgetTracker,
          undefined, // agentId — 暂不使用
          budget,
          budgetTracker.lastGlobalTurnTokens,
        )

        if (budgetDecision.action === 'continue') {
          // 注入续写消息继续循环
          const continueMsg = this.createUserMessage(budgetDecision.nudgeMessage)
          messages = [...messages, continueMsg]
          continue
        }

        // --- Step 3.5: Stop hooks ---
        const hookResult = await this.deps.hooks.onStop(messages, {})
        if (hookResult.preventContinuation) {
          yield { type: 'done', reason: 'stop_hook' as DoneReason }
          return
        }

        yield { type: 'done', reason: 'end_turn' as DoneReason, usage: this.aggregateUsage(messages) }
        return
      }

      // --- Step 4-7: 处理 tool_use ---
      const toolUses = this.extractToolUses(assistantMessage)
      if (toolUses.length === 0) {
        yield { type: 'done', reason: 'end_turn' as DoneReason }
        return
      }

      const toolResultContents: CoreContentBlock[] = []
      for (const toolUse of toolUses) {
        // 检查中断
        if (shouldAbort(abortSignal)) {
          // 为剩余的 tool_use 生成 synthetic result
          toolResultContents.push(
            ...createSyntheticToolResults([assistantMessage!]),
          )
          break
        }

        const tool = this.deps.tools.find(toolUse.name)
        if (!tool) {
          toolResultContents.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: `Unknown tool: ${toolUse.name}`,
            is_error: true,
          })
          continue
        }

        // 权限检查
        const permissionResult = await this.deps.permission.canUseTool(
          tool,
          toolUse.input,
          { mode: 'default', input: toolUse.input },
        )

        if (!permissionResult.allowed) {
          toolResultContents.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: `Permission denied: ${permissionResult.reason}`,
            is_error: true,
          })
          continue
        }

        // 执行工具
        yield {
          type: 'tool_start',
          toolUseId: toolUse.id,
          toolName: toolUse.name,
          input: toolUse.input,
        }

        try {
          const result: ToolResult = await this.deps.tools.execute(
            tool,
            toolUse.input,
            { abortSignal: abortSignal ?? new AbortController().signal, toolUseId: toolUse.id },
          )

          yield {
            type: 'tool_result',
            toolUseId: toolUse.id,
            result,
          }

          toolResultContents.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: result.output,
            ...(result.error ? { is_error: true } : {}),
          })
        } catch (error) {
          const errorResult: ToolResult = {
            output: `Tool execution error: ${error instanceof Error ? error.message : String(error)}`,
            error: true,
          }

          yield {
            type: 'tool_result',
            toolUseId: toolUse.id,
            result: errorResult,
          }

          toolResultContents.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: errorResult.output as string,
            is_error: true,
          })
        }
      }

      // 追加 tool result 消息
      const toolResultMsg = this.createUserMessageFromBlocks(toolResultContents)
      messages = [...messages, toolResultMsg]
      yield { type: 'message', message: toolResultMsg }

      // --- Step 8: Compaction ---
      const totalTokens = this.aggregateUsage(messages)
      const compactionResult = await this.deps.compaction.maybeCompact(
        messages,
        totalTokens.input_tokens + totalTokens.output_tokens,
      )
      if (compactionResult.compacted) {
        yield {
          type: 'compaction',
          before: messages,
          after: compactionResult.messages,
        }
        messages = compactionResult.messages
      }

      // --- Step 9: 继续下一次循环 ---
    }

    // 达到 max turns
    yield { type: 'done', reason: 'max_turns' as DoneReason, usage: this.aggregateUsage(messages) }
  }

  // --- Helper 方法 ---

  private collectTools(): CoreTool[] {
    // 从 deps 获取工具列表 — 当前简化为空列表
    // 实际实现中由 ToolDep 提供
    return []
  }

  private createUserMessage(
    text: string,
    attachments?: Array<{ type: string; [key: string]: unknown }>,
  ): CoreUserMessage {
    const content: CoreContentBlock[] = []
    if (attachments && attachments.length > 0) {
      for (const att of attachments) {
        content.push({ type: 'text', text: JSON.stringify(att) })
      }
    }
    content.push({ type: 'text', text })
    return {
      type: 'user',
      uuid: crypto.randomUUID(),
      role: 'user',
      content,
      timestamp: Date.now(),
      // 嵌套格式兼容 — queryModel() 的 normalizeMessagesForAPI 访问 message.message.content
      message: { role: 'user', content },
    }
  }

  private createUserMessageFromBlocks(
    blocks: CoreContentBlock[],
  ): CoreUserMessage {
    return {
      type: 'user',
      uuid: crypto.randomUUID(),
      role: 'user',
      content: blocks,
      timestamp: Date.now(),
      // 嵌套格式兼容 — 工具结果需要 message.message.content 才能被 queryModel 正确处理
      message: { role: 'user', content: blocks },
    }
  }

  private processStreamEvent(
    event: ProviderEvent,
    turnState: TurnState,
  ): void {
    // 从流事件中累积 content blocks、usage 等
    if (event.type === 'message_start' && 'message' in event) {
      const msg = event.message as { usage?: Usage }
      if (msg.usage) {
        turnState.turnUsage = { ...msg.usage }
      }
    }
    if (event.type === 'content_block_start' && 'content_block' in event) {
      const block = event.content_block as { type: string; id?: string; name?: string; input?: unknown; text?: string; thinking?: string }
      if (block.type === 'tool_use' && block.id && block.name) {
        turnState.pendingToolUses.push({
          id: block.id,
          name: block.name,
          input: block.input ?? {},
        })
      } else if (block.type === 'text') {
        turnState.textBlocks.push({ type: 'text', text: '' })
        turnState.currentTextBlockIndex = turnState.textBlocks.length - 1
      } else if (block.type === 'thinking') {
        turnState.thinkingBlocks.push({ type: 'thinking', thinking: '' })
        turnState.currentThinkingBlockIndex = turnState.thinkingBlocks.length - 1
      }
    }
    if (event.type === 'content_block_delta') {
      const delta = (event as any).delta as { type?: string; text?: string; thinking?: string; partial_json?: string }
      if (delta?.type === 'text_delta' && delta.text != null && turnState.currentTextBlockIndex >= 0) {
        turnState.textBlocks[turnState.currentTextBlockIndex].text += delta.text
      } else if (delta?.type === 'thinking_delta' && delta.thinking != null && turnState.currentThinkingBlockIndex >= 0) {
        turnState.thinkingBlocks[turnState.currentThinkingBlockIndex].thinking += delta.thinking
      }
    }
    if (event.type === 'message_delta' && 'delta' in event) {
      const delta = event.delta as { stop_reason?: string }
      if (delta.stop_reason) {
        turnState.stopReason = delta.stop_reason
      }
      if ('usage' in event) {
        const usage = event.usage as { output_tokens: number }
        turnState.turnUsage.output_tokens += usage.output_tokens
      }
    }
  }

  private buildAssistantMessage(
    turnState: TurnState,
  ): CoreAssistantMessage {
    // 组装 content blocks：先 thinking，再 text，最后 tool_use
    const content: CoreContentBlock[] = [
      ...turnState.thinkingBlocks,
      ...turnState.textBlocks,
      ...turnState.pendingToolUses.map(tu => ({
        type: 'tool_use' as const,
        id: tu.id,
        name: tu.name,
        input: tu.input,
      })),
    ]
    return {
      type: 'assistant',
      uuid: crypto.randomUUID(),
      role: 'assistant',
      content,
      usage: { ...turnState.turnUsage },
      stop_reason: turnState.stopReason,
      timestamp: Date.now(),
      // 嵌套格式兼容 — 与 queryModel 返回的 AssistantMessage 格式一致
      message: {
        role: 'assistant',
        content,
        stop_reason: turnState.stopReason,
        usage: { ...turnState.turnUsage },
      },
    }
  }

  private extractToolUses(
    message: CoreAssistantMessage | null,
  ): Array<{ id: string; name: string; input: unknown }> {
    if (!message) return []
    // 兼容两种格式：扁平 CoreMessage.content 和嵌套 Message.message.content
    const raw = message as any
    const content = Array.isArray(raw.content)
      ? raw.content
      : Array.isArray(raw.message?.content)
        ? raw.message.content
        : null
    if (!content) return []
    return content
      .filter(
        (block: any) =>
          typeof block === 'object' && block !== null && 'type' in block && block.type === 'tool_use',
      )
      .map((block: any) => ({
        id: block.id,
        name: block.name,
        input: block.input,
      }))
  }

  private aggregateUsage(messages: CoreMessage[]): Usage {
    const total: Usage = { input_tokens: 0, output_tokens: 0 }
    for (const msg of messages) {
      if (msg.type === 'assistant' && 'usage' in msg && msg.usage) {
        const usage = msg.usage as Usage
        total.input_tokens += usage.input_tokens
        total.output_tokens += usage.output_tokens
        if (usage.cache_creation_input_tokens) {
          total.cache_creation_input_tokens =
            (total.cache_creation_input_tokens ?? 0) + usage.cache_creation_input_tokens
        }
        if (usage.cache_read_input_tokens) {
          total.cache_read_input_tokens =
            (total.cache_read_input_tokens ?? 0) + usage.cache_read_input_tokens
        }
      }
    }
    return total
  }
}
