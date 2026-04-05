// ToolDepImpl — 将 AgentDeps.tools 桥接到 ToolRegistry + toolExecution
// 委托到 tools/registry/ToolRegistry.ts 已实现的注册中心

import type { ToolDep, CoreTool, ToolResult, ToolExecContext } from '@anthropic/agent'
import type { Tool, ToolUseContext, Tools } from '../Tool.js'
import { findToolByName } from '../Tool.js'
import { ToolRegistry } from '../tools/registry/index.js'

export class ToolDepImpl implements ToolDep {
  private tools: Tools
  private toolUseContext: ToolUseContext

  constructor(tools: Tools, toolUseContext: ToolUseContext) {
    this.tools = tools
    this.toolUseContext = toolUseContext
  }

  find(name: string): CoreTool | undefined {
    // 优先从 ToolRegistry 查找
    const tool = findToolByName(this.tools, name)
    if (!tool) return undefined
    return this.toCoreTool(tool)
  }

  async execute(tool: CoreTool, input: unknown, context: ToolExecContext): Promise<ToolResult> {
    // 找到原始 Tool 实例
    const realTool = findToolByName(this.tools, tool.name)
    if (!realTool) {
      return { output: `Tool not found: ${tool.name}`, error: true }
    }

    try {
      // 调用 Tool.call() — 签名: (args, context, canUseTool, parentMessage, onProgress?)
      const result = await realTool.call(
        input as any,
        {
          ...this.toolUseContext,
          toolUseId: context.toolUseId,
        },
        async () => ({ decision: 'allow' as const }),
        { type: 'assistant', uuid: crypto.randomUUID(), message: { role: 'assistant', content: [] } } as any,
        // onProgress — 工具执行进度回调（WebSearch 等工具需要）
        (_progress: unknown) => {},
      )

      // 将 Tool 的原始输出转为 ToolResult
      if (typeof result === 'string') {
        return { output: result }
      }
      return {
        output: typeof result === 'object' && result !== null
          ? JSON.stringify(result)
          : String(result),
      }
    } catch (error) {
      return {
        output: error instanceof Error ? error.message : String(error),
        error: true,
      }
    }
  }

  private toCoreTool(tool: Tool): CoreTool {
    return {
      name: tool.name,
      description: '', // Tool.description 是 async 函数，此处简化
      inputSchema: (tool.inputJSONSchema ?? { type: 'object' }) as any,
      userFacingName: tool.userFacingName(undefined),
      isLocal: !tool.isMcp,
      isMcp: !!tool.isMcp,
    }
  }
}
