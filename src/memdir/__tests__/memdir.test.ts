import { describe, expect, test } from "bun:test"
import {
  truncateEntrypointContent,
  MAX_ENTRYPOINT_LINES,
  MAX_ENTRYPOINT_BYTES,
  ENTRYPOINT_NAME,
  buildMemoryLines,
} from "../memdir"

describe("truncateEntrypointContent", () => {
  test("returns content unchanged when within limits", () => {
    const content = "line1\nline2\nline3"
    const result = truncateEntrypointContent(content)
    expect(result.content).toBe(content)
    expect(result.wasLineTruncated).toBe(false)
    expect(result.wasByteTruncated).toBe(false)
    expect(result.lineCount).toBe(3)
  })

  test("handles empty content", () => {
    const result = truncateEntrypointContent("")
    expect(result.content).toBe("")
    expect(result.wasLineTruncated).toBe(false)
    expect(result.lineCount).toBe(1) // empty string splits to [""]
  })

  test("truncates by line count when exceeding MAX_ENTRYPOINT_LINES", () => {
    const lines = Array.from({ length: MAX_ENTRYPOINT_LINES + 50 }, (_, i) => `line ${i}`)
    const content = lines.join("\n")
    const result = truncateEntrypointContent(content)
    expect(result.wasLineTruncated).toBe(true)
    expect(result.wasByteTruncated).toBe(false)
    // Content should contain the warning
    expect(result.content).toContain("WARNING")
    expect(result.content).toContain(ENTRYPOINT_NAME)
    // First MAX_ENTRYPOINT_LINES lines should be preserved
    const resultLines = result.content.split("\n")
    expect(resultLines[0]).toBe("line 0")
  })

  test("truncates by byte count when exceeding MAX_ENTRYPOINT_BYTES", () => {
    // Create content with few lines but huge size
    const hugeLine = "x".repeat(MAX_ENTRYPOINT_BYTES + 1000)
    const content = `header\n${hugeLine}`
    const result = truncateEntrypointContent(content)
    expect(result.wasByteTruncated).toBe(true)
    expect(result.content).toContain("WARNING")
    expect(result.content.length).toBeLessThan(content.length)
  })

  test("truncates both when exceeding both limits", () => {
    const lines = Array.from(
      { length: MAX_ENTRYPOINT_LINES + 10 },
      () => "x".repeat(200),
    )
    const content = lines.join("\n")
    const result = truncateEntrypointContent(content)
    expect(result.wasLineTruncated).toBe(true)
    expect(result.wasByteTruncated).toBe(true)
  })

  test("trims whitespace from input", () => {
    const content = "  line1\nline2\n  "
    const result = truncateEntrypointContent(content)
    expect(result.content).toBe("line1\nline2")
  })
})

describe("buildMemoryLines", () => {
  test("returns non-empty array", () => {
    const lines = buildMemoryLines("test memory", "/tmp/mem")
    expect(lines.length).toBeGreaterThan(0)
  })

  test("starts with the display name as heading", () => {
    const lines = buildMemoryLines("my memory", "/tmp/mem")
    expect(lines[0]).toBe("# my memory")
  })

  test("includes the memory directory path", () => {
    const lines = buildMemoryLines("test", "/custom/path/memory/")
    const joined = lines.join("\n")
    expect(joined).toContain("/custom/path/memory/")
  })

  test("includes MEMORY.md as entrypoint name", () => {
    const lines = buildMemoryLines("test", "/tmp/mem")
    const joined = lines.join("\n")
    expect(joined).toContain("MEMORY.md")
  })

  test("includes type taxonomy", () => {
    const lines = buildMemoryLines("test", "/tmp/mem")
    const joined = lines.join("\n")
    expect(joined).toContain("user")
    expect(joined).toContain("feedback")
    expect(joined).toContain("project")
    expect(joined).toContain("reference")
  })

  test("includes How to save section with index when skipIndex=false", () => {
    const lines = buildMemoryLines("test", "/tmp/mem", undefined, false)
    const joined = lines.join("\n")
    expect(joined).toContain("How to save memories")
    expect(joined).toContain("Step 2")
  })

  test("skips Step 2 index instructions when skipIndex=true", () => {
    const lines = buildMemoryLines("test", "/tmp/mem", undefined, true)
    const joined = lines.join("\n")
    expect(joined).toContain("How to save memories")
    expect(joined).not.toContain("Step 2")
  })

  test("includes extra guidelines", () => {
    const guidelines = ["Custom rule 1", "Custom rule 2"]
    const lines = buildMemoryLines("test", "/tmp/mem", guidelines)
    const joined = lines.join("\n")
    expect(joined).toContain("Custom rule 1")
    expect(joined).toContain("Custom rule 2")
  })
})
