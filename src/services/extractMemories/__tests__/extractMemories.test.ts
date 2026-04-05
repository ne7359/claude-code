/**
 * Tests for extractMemories module logic that can be tested in isolation.
 * The module uses closure-scoped state initialized via initExtractMemories(),
 * and depends on forkedAgent/GrowthBook at runtime. We test the pure helper
 * functions that don't require those dependencies.
 */
import { describe, expect, test } from "bun:test"

describe("extractMemories helpers", () => {
  // Test the message counting logic by recreating the pure function
  function isModelVisibleMessage(message: { type: string }): boolean {
    return message.type === 'user' || message.type === 'assistant'
  }

  function countModelVisibleMessagesSince(
    messages: { type: string; uuid: string }[],
    sinceUuid: string | undefined,
  ): number {
    if (sinceUuid === null || sinceUuid === undefined) {
      return messages.filter(isModelVisibleMessage).length
    }

    let foundStart = false
    let n = 0
    for (const message of messages) {
      if (!foundStart) {
        if (message.uuid === sinceUuid) {
          foundStart = true
        }
        continue
      }
      if (isModelVisibleMessage(message)) {
        n++
      }
    }
    if (!foundStart) {
      return messages.filter(isModelVisibleMessage).length
    }
    return n
  }

  describe("countModelVisibleMessagesSince", () => {
    const messages = [
      { type: "user", uuid: "a" },
      { type: "assistant", uuid: "b" },
      { type: "system", uuid: "c" },
      { type: "user", uuid: "d" },
      { type: "assistant", uuid: "e" },
    ]

    test("counts all visible messages when sinceUuid is undefined", () => {
      expect(countModelVisibleMessagesSince(messages, undefined)).toBe(4)
    })

    test("counts messages after the cursor", () => {
      expect(countModelVisibleMessagesSince(messages, "b")).toBe(2) // d (user) + e (assistant)
    })

    test("counts zero when cursor is at last message", () => {
      expect(countModelVisibleMessagesSince(messages, "e")).toBe(0)
    })

    test("falls back to full count when sinceUuid not found", () => {
      expect(countModelVisibleMessagesSince(messages, "nonexistent")).toBe(4)
    })

    test("excludes system messages", () => {
      const sysMessages = [
        { type: "system", uuid: "s1" },
        { type: "system", uuid: "s2" },
      ]
      expect(countModelVisibleMessagesSince(sysMessages, undefined)).toBe(0)
    })

    test("handles empty messages array", () => {
      expect(countModelVisibleMessagesSince([], undefined)).toBe(0)
    })
  })

  describe("getWrittenFilePath extraction", () => {
    // Recreate the pure function from extractMemories.ts
    function getWrittenFilePath(block: {
      type: string
      name?: string
      input?: unknown
    }): string | undefined {
      if (
        block.type !== 'tool_use' ||
        (block.name !== 'Edit' && block.name !== 'Write')
      ) {
        return undefined
      }
      const input = block.input
      if (typeof input === 'object' && input !== null && 'file_path' in input) {
        const fp = (input as { file_path: unknown }).file_path
        return typeof fp === 'string' ? fp : undefined
      }
      return undefined
    }

    test("extracts file_path from Write tool_use block", () => {
      const block = {
        type: "tool_use",
        name: "Write",
        input: { file_path: "/mem/test.md", content: "hello" },
      }
      expect(getWrittenFilePath(block)).toBe("/mem/test.md")
    })

    test("extracts file_path from Edit tool_use block", () => {
      const block = {
        type: "tool_use",
        name: "Edit",
        input: { file_path: "/mem/other.md", old_string: "a", new_string: "b" },
      }
      expect(getWrittenFilePath(block)).toBe("/mem/other.md")
    })

    test("returns undefined for non-tool_use block", () => {
      expect(getWrittenFilePath({ type: "text", name: "Write" })).toBeUndefined()
    })

    test("returns undefined for other tool names", () => {
      expect(
        getWrittenFilePath({ type: "tool_use", name: "Bash", input: { command: "ls" } }),
      ).toBeUndefined()
    })

    test("returns undefined when input has no file_path", () => {
      expect(
        getWrittenFilePath({ type: "tool_use", name: "Write", input: {} }),
      ).toBeUndefined()
    })

    test("returns undefined when file_path is not a string", () => {
      expect(
        getWrittenFilePath({ type: "tool_use", name: "Write", input: { file_path: 123 } }),
      ).toBeUndefined()
    })
  })

  describe("hasMemoryWritesSince detection", () => {
    // Simplified version of the function for testing the logic
    function hasMemoryWritesSince(
      messages: { uuid: string; type: string; content?: unknown }[],
      sinceUuid: string | undefined,
      memoryDir: string,
    ): boolean {
      let foundStart = sinceUuid === undefined
      for (const message of messages) {
        if (!foundStart) {
          if (message.uuid === sinceUuid) {
            foundStart = true
          }
          continue
        }
        if (message.type !== 'assistant') continue
        const content = message.content
        if (!Array.isArray(content)) continue
        for (const block of content as { type: string; name?: string; input?: unknown }[]) {
          if (
            block.type === 'tool_use' &&
            (block.name === 'Edit' || block.name === 'Write')
          ) {
            const input = block.input as Record<string, unknown> | null
            if (
              input &&
              typeof input === 'object' &&
              'file_path' in input &&
              typeof input.file_path === 'string' &&
              input.file_path.startsWith(memoryDir)
            ) {
              return true
            }
          }
        }
      }
      return false
    }

    test("detects Write to memory dir after cursor", () => {
      const messages = [
        { uuid: "a", type: "user" },
        {
          uuid: "b",
          type: "assistant",
          content: [
            { type: "tool_use", name: "Write", input: { file_path: "/mem/test.md" } },
          ],
        },
      ]
      expect(hasMemoryWritesSince(messages, "a", "/mem/")).toBe(true)
    })

    test("returns false when no memory writes after cursor", () => {
      const messages = [
        { uuid: "a", type: "user" },
        {
          uuid: "b",
          type: "assistant",
          content: [
            { type: "tool_use", name: "Bash", input: { command: "ls" } },
          ],
        },
      ]
      expect(hasMemoryWritesSince(messages, "a", "/mem/")).toBe(false)
    })

    test("returns false for writes outside memory dir", () => {
      const messages = [
        { uuid: "a", type: "user" },
        {
          uuid: "b",
          type: "assistant",
          content: [
            { type: "tool_use", name: "Write", input: { file_path: "/tmp/other.md" } },
          ],
        },
      ]
      expect(hasMemoryWritesSince(messages, "a", "/mem/")).toBe(false)
    })

    test("scans from beginning when sinceUuid is undefined", () => {
      const messages = [
        {
          uuid: "b",
          type: "assistant",
          content: [
            { type: "tool_use", name: "Write", input: { file_path: "/mem/test.md" } },
          ],
        },
      ]
      expect(hasMemoryWritesSince(messages, undefined, "/mem/")).toBe(true)
    })
  })
})
