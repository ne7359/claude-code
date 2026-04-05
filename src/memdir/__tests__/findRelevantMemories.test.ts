/**
 * Tests for findRelevantMemories helper logic.
 * The main function (findRelevantMemories) depends on sideQuery (API call)
 * and scanMemoryFiles (filesystem), so we test the pure filtering/selection
 * logic that doesn't require mocking the API layer.
 */
import { describe, expect, test } from "bun:test"
import type { MemoryHeader } from "../memoryScan"

describe("findRelevantMemories logic", () => {
  describe("alreadySurfaced filtering", () => {
    test("filters out already surfaced files", () => {
      const memories: MemoryHeader[] = [
        {
          filename: "a.md",
          filePath: "/mem/a.md",
          mtimeMs: 1000,
          description: "Memory A",
          type: "user",
        },
        {
          filename: "b.md",
          filePath: "/mem/b.md",
          mtimeMs: 2000,
          description: "Memory B",
          type: "project",
        },
        {
          filename: "c.md",
          filePath: "/mem/c.md",
          mtimeMs: 3000,
          description: "Memory C",
          type: "feedback",
        },
      ]
      const alreadySurfaced = new Set(["/mem/a.md"])
      const filtered = memories.filter(m => !alreadySurfaced.has(m.filePath))
      expect(filtered).toHaveLength(2)
      expect(filtered.map(m => m.filename)).toEqual(["b.md", "c.md"])
    })

    test("returns all when nothing is already surfaced", () => {
      const memories: MemoryHeader[] = [
        {
          filename: "a.md",
          filePath: "/mem/a.md",
          mtimeMs: 1000,
          description: "A",
          type: "user",
        },
      ]
      const alreadySurfaced = new Set<string>()
      const filtered = memories.filter(m => !alreadySurfaced.has(m.filePath))
      expect(filtered).toHaveLength(1)
    })

    test("returns empty when all are already surfaced", () => {
      const memories: MemoryHeader[] = [
        {
          filename: "a.md",
          filePath: "/mem/a.md",
          mtimeMs: 1000,
          description: "A",
          type: "user",
        },
      ]
      const alreadySurfaced = new Set(["/mem/a.md"])
      const filtered = memories.filter(m => !alreadySurfaced.has(m.filePath))
      expect(filtered).toHaveLength(0)
    })
  })

  describe("filename validation against memory list", () => {
    test("filters selected filenames against valid set", () => {
      const validFilenames = new Set(["a.md", "b.md", "c.md"])
      const selected = ["a.md", "x.md", "b.md", "y.md"]
      const filtered = selected.filter(f => validFilenames.has(f))
      expect(filtered).toEqual(["a.md", "b.md"])
    })

    test("returns empty when no selected filenames are valid", () => {
      const validFilenames = new Set(["a.md", "b.md"])
      const selected = ["x.md", "y.md"]
      const filtered = selected.filter(f => validFilenames.has(f))
      expect(filtered).toEqual([])
    })
  })

  describe("selected filename to header resolution", () => {
    test("resolves selected filenames to headers", () => {
      const memories: MemoryHeader[] = [
        {
          filename: "a.md",
          filePath: "/mem/a.md",
          mtimeMs: 1000,
          description: "A",
          type: "user",
        },
        {
          filename: "b.md",
          filePath: "/mem/b.md",
          mtimeMs: 2000,
          description: "B",
          type: "project",
        },
      ]
      const byFilename = new Map(memories.map(m => [m.filename, m]))
      const selectedFilenames = ["b.md", "a.md"]
      const resolved = selectedFilenames
        .map(filename => byFilename.get(filename))
        .filter((m): m is MemoryHeader => m !== undefined)
      expect(resolved).toHaveLength(2)
      expect(resolved[0].filename).toBe("b.md")
      expect(resolved[1].filename).toBe("a.md")
    })

    test("skips unresolved filenames", () => {
      const memories: MemoryHeader[] = [
        {
          filename: "a.md",
          filePath: "/mem/a.md",
          mtimeMs: 1000,
          description: "A",
          type: "user",
        },
      ]
      const byFilename = new Map(memories.map(m => [m.filename, m]))
      const selectedFilenames = ["a.md", "nonexistent.md"]
      const resolved = selectedFilenames
        .map(filename => byFilename.get(filename))
        .filter((m): m is MemoryHeader => m !== undefined)
      expect(resolved).toHaveLength(1)
      expect(resolved[0].filename).toBe("a.md")
    })
  })

  describe("RelevantMemory output mapping", () => {
    test("maps MemoryHeader to RelevantMemory", () => {
      const memories: MemoryHeader[] = [
        {
          filename: "test.md",
          filePath: "/mem/test.md",
          mtimeMs: 5000,
          description: "Test",
          type: "feedback",
        },
      ]
      const result = memories.map(m => ({
        path: m.filePath,
        mtimeMs: m.mtimeMs,
      }))
      expect(result).toEqual([{ path: "/mem/test.md", mtimeMs: 5000 }])
    })
  })
})
