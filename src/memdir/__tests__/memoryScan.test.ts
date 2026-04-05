import { describe, expect, test } from "bun:test"
import { formatMemoryManifest, type MemoryHeader } from "../memoryScan"

describe("formatMemoryManifest", () => {
  test("formats headers with type, filename, timestamp, and description", () => {
    const memories: MemoryHeader[] = [
      {
        filename: "user_role.md",
        filePath: "/mem/user_role.md",
        mtimeMs: new Date("2026-01-15T10:30:00Z").getTime(),
        description: "User is a data scientist",
        type: "user",
      },
    ]
    const manifest = formatMemoryManifest(memories)
    expect(manifest).toContain("[user] user_role.md")
    expect(manifest).toContain("User is a data scientist")
    expect(manifest).toContain("2026-01-15")
  })

  test("omits type tag when type is undefined", () => {
    const memories: MemoryHeader[] = [
      {
        filename: "legacy.md",
        filePath: "/mem/legacy.md",
        mtimeMs: Date.now(),
        description: "Old memory",
        type: undefined,
      },
    ]
    const manifest = formatMemoryManifest(memories)
    expect(manifest).toContain("- legacy.md")
    expect(manifest).not.toContain("[undefined]")
  })

  test("omits description when null", () => {
    const memories: MemoryHeader[] = [
      {
        filename: "no_desc.md",
        filePath: "/mem/no_desc.md",
        mtimeMs: Date.now(),
        description: null,
        type: "project",
      },
    ]
    const manifest = formatMemoryManifest(memories)
    expect(manifest).toContain("[project] no_desc.md")
    // Should end at the closing paren of timestamp, no colon+desc
    expect(manifest).not.toContain(": null")
  })

  test("formats multiple memories", () => {
    const memories: MemoryHeader[] = [
      {
        filename: "a.md",
        filePath: "/mem/a.md",
        mtimeMs: 3000,
        description: "First",
        type: "user",
      },
      {
        filename: "b.md",
        filePath: "/mem/b.md",
        mtimeMs: 2000,
        description: "Second",
        type: "feedback",
      },
    ]
    const manifest = formatMemoryManifest(memories)
    const lines = manifest.split("\n")
    expect(lines).toHaveLength(2)
  })

  test("returns empty string for empty array", () => {
    expect(formatMemoryManifest([])).toBe("")
  })
})
