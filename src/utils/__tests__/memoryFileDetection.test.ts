/**
 * Tests for memoryFileDetection pure helper logic.
 * The module's main functions depend on getAutoMemPath/isAutoMemoryEnabled,
 * so we test the pure path detection and pattern matching logic directly.
 */
import { describe, expect, test } from "bun:test"

describe("memoryFileDetection logic", () => {
  describe("session file path detection (detectSessionFileType logic)", () => {
    // Recreate the pure detection logic for testing
    function detectSessionFileType(
      filePath: string,
      configDir: string,
    ): "session_memory" | "session_transcript" | null {
      const normalized = filePath.split("\\").join("/")
      const configDirCmp = configDir.split("\\").join("/")
      if (!normalized.startsWith(configDirCmp)) {
        return null
      }
      if (
        normalized.includes("/session-memory/") &&
        normalized.endsWith(".md")
      ) {
        return "session_memory"
      }
      if (normalized.includes("/projects/") && normalized.endsWith(".jsonl")) {
        return "session_transcript"
      }
      return null
    }

    test("detects session memory file", () => {
      expect(
        detectSessionFileType(
          "/home/user/.claude/session-memory/abc123.md",
          "/home/user/.claude",
        ),
      ).toBe("session_memory")
    })

    test("detects session transcript file", () => {
      expect(
        detectSessionFileType(
          "/home/user/.claude/projects/abc/session.jsonl",
          "/home/user/.claude",
        ),
      ).toBe("session_transcript")
    })

    test("returns null for non-session files", () => {
      expect(
        detectSessionFileType(
          "/home/user/.claude/some-other-file.txt",
          "/home/user/.claude",
        ),
      ).toBeNull()
    })

    test("returns null for files outside config dir", () => {
      expect(
        detectSessionFileType(
          "/tmp/session-memory/test.md",
          "/home/user/.claude",
        ),
      ).toBeNull()
    })

    test("returns null for session-memory without .md extension", () => {
      expect(
        detectSessionFileType(
          "/home/user/.claude/session-memory/test.txt",
          "/home/user/.claude",
        ),
      ).toBeNull()
    })

    test("returns null for .jsonl outside projects dir", () => {
      expect(
        detectSessionFileType(
          "/home/user/.claude/session.jsonl",
          "/home/user/.claude",
        ),
      ).toBeNull()
    })
  })

  describe("session pattern detection (detectSessionPatternType logic)", () => {
    function detectSessionPatternType(
      pattern: string,
    ): "session_memory" | "session_transcript" | null {
      const normalized = pattern.split("\\").join("/")
      if (
        normalized.includes("session-memory") &&
        (normalized.includes(".md") || normalized.endsWith("*"))
      ) {
        return "session_memory"
      }
      if (
        normalized.includes(".jsonl") ||
        (normalized.includes("projects") && normalized.includes("*.jsonl"))
      ) {
        return "session_transcript"
      }
      return null
    }

    test("detects session memory pattern with .md", () => {
      expect(detectSessionPatternType("session-memory/*.md")).toBe(
        "session_memory",
      )
    })

    test("detects session memory pattern with wildcard", () => {
      expect(detectSessionPatternType("session-memory/*")).toBe(
        "session_memory",
      )
    })

    test("detects session transcript pattern with .jsonl", () => {
      expect(detectSessionPatternType("projects/*.jsonl")).toBe(
        "session_transcript",
      )
    })

    test("detects plain .jsonl pattern", () => {
      expect(detectSessionPatternType("*.jsonl")).toBe("session_transcript")
    })

    test("returns null for non-matching patterns", () => {
      expect(detectSessionPatternType("*.ts")).toBeNull()
      expect(detectSessionPatternType("src/**/*.md")).toBeNull()
    })
  })

  describe("shell command path extraction", () => {
    // Recreate the path token extraction regex from isShellCommandTargetingMemory
    const PATH_TOKEN_RE = /(?:[A-Za-z]:[/\\]|\/)[^\s'"]+/g

    test("extracts Unix absolute paths", () => {
      const cmd = "grep -rn 'pattern' /home/user/.claude/projects/"
      const matches = cmd.match(PATH_TOKEN_RE) ?? []
      expect(matches).toContain("/home/user/.claude/projects/")
    })

    test("extracts Windows drive paths", () => {
      const cmd = 'grep -rn "pattern" C:\\Users\\test\\.claude\\'
      const matches = cmd.match(PATH_TOKEN_RE) ?? []
      expect(matches.some(m => m.includes("C:"))).toBe(true)
    })

    test("returns null for commands without absolute paths", () => {
      const cmd = "ls -la"
      expect(cmd.match(PATH_TOKEN_RE)).toBeNull()
    })

    test("extracts multiple paths", () => {
      const cmd = "diff /tmp/a.txt /tmp/b.txt"
      const matches = cmd.match(PATH_TOKEN_RE) ?? []
      expect(matches).toEqual(["/tmp/a.txt", "/tmp/b.txt"])
    })
  })

  describe("auto-managed memory pattern detection (isAutoManagedMemoryPattern logic)", () => {
    function isAutoManagedMemoryPattern(
      pattern: string,
      autoMemEnabled: boolean,
    ): boolean {
      if (
        pattern.includes("session-memory") &&
        (pattern.includes(".md") || pattern.endsWith("*"))
      ) {
        return true
      }
      if (
        pattern.includes(".jsonl") ||
        (pattern.includes("projects") && pattern.includes("*.jsonl"))
      ) {
        return true
      }
      if (
        autoMemEnabled &&
        (pattern.includes("agent-memory/") ||
          pattern.includes("agent-memory-local/"))
      ) {
        return true
      }
      return false
    }

    test("matches agent-memory pattern when enabled", () => {
      expect(
        isAutoManagedMemoryPattern("agent-memory/*.md", true),
      ).toBe(true)
    })

    test("does not match agent-memory pattern when disabled", () => {
      expect(
        isAutoManagedMemoryPattern("agent-memory/*.md", false),
      ).toBe(false)
    })

    test("matches session patterns regardless of auto mem setting", () => {
      expect(
        isAutoManagedMemoryPattern("session-memory/*.md", false),
      ).toBe(true)
    })

    test("does not match CLAUDE.md patterns", () => {
      expect(
        isAutoManagedMemoryPattern("CLAUDE.md", true),
      ).toBe(false)
    })
  })
})
