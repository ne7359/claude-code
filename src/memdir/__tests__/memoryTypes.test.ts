import { describe, expect, test } from "bun:test"
import {
  MEMORY_TYPES,
  parseMemoryType,
  TYPES_SECTION_INDIVIDUAL,
  TYPES_SECTION_COMBINED,
  WHAT_NOT_TO_SAVE_SECTION,
  WHEN_TO_ACCESS_SECTION,
  TRUSTING_RECALL_SECTION,
  MEMORY_FRONTMATTER_EXAMPLE,
  MEMORY_DRIFT_CAVEAT,
} from "../memoryTypes"

describe("MEMORY_TYPES", () => {
  test("contains exactly four types", () => {
    expect(MEMORY_TYPES).toEqual(["user", "feedback", "project", "reference"])
  })

  test("has tuple type (readonly via 'as const')", () => {
    // MEMORY_TYPES is typed `readonly [...]` via `as const`
    expect(Array.isArray(MEMORY_TYPES)).toBe(true)
    expect(MEMORY_TYPES.length).toBe(4)
  })
})

describe("parseMemoryType", () => {
  test("returns valid types", () => {
    expect(parseMemoryType("user")).toBe("user")
    expect(parseMemoryType("feedback")).toBe("feedback")
    expect(parseMemoryType("project")).toBe("project")
    expect(parseMemoryType("reference")).toBe("reference")
  })

  test("returns undefined for unknown string", () => {
    expect(parseMemoryType("unknown")).toBeUndefined()
    expect(parseMemoryType("USER")).toBeUndefined()
    expect(parseMemoryType("")).toBeUndefined()
  })

  test("returns undefined for non-string input", () => {
    expect(parseMemoryType(null)).toBeUndefined()
    expect(parseMemoryType(undefined)).toBeUndefined()
    expect(parseMemoryType(42)).toBeUndefined()
    expect(parseMemoryType({})).toBeUndefined()
  })
})

describe("TYPES_SECTION_INDIVIDUAL", () => {
  test("starts with the correct header", () => {
    expect(TYPES_SECTION_INDIVIDUAL[0]).toBe("## Types of memory")
  })

  test("contains all four type names", () => {
    const joined = TYPES_SECTION_INDIVIDUAL.join("\n")
    for (const type of MEMORY_TYPES) {
      expect(joined).toContain(`<name>${type}</name>`)
    }
  })

  test("does not contain <scope> tags", () => {
    const joined = TYPES_SECTION_INDIVIDUAL.join("\n")
    expect(joined).not.toContain("<scope>")
  })
})

describe("TYPES_SECTION_COMBINED", () => {
  test("starts with the correct header", () => {
    expect(TYPES_SECTION_COMBINED[0]).toBe("## Types of memory")
  })

  test("contains all four type names", () => {
    const joined = TYPES_SECTION_COMBINED.join("\n")
    for (const type of MEMORY_TYPES) {
      expect(joined).toContain(`<name>${type}</name>`)
    }
  })

  test("contains <scope> tags", () => {
    const joined = TYPES_SECTION_COMBINED.join("\n")
    expect(joined).toContain("<scope>")
  })
})

describe("WHAT_NOT_TO_SAVE_SECTION", () => {
  test("starts with correct header", () => {
    expect(WHAT_NOT_TO_SAVE_SECTION[0]).toBe("## What NOT to save in memory")
  })

  test("mentions key exclusions", () => {
    const joined = WHAT_NOT_TO_SAVE_SECTION.join("\n")
    expect(joined).toContain("CLAUDE.md")
    expect(joined).toContain("git log")
  })
})

describe("WHEN_TO_ACCESS_SECTION", () => {
  test("starts with correct header", () => {
    expect(WHEN_TO_ACCESS_SECTION[0]).toBe("## When to access memories")
  })

  test("includes the drift caveat", () => {
    expect(WHEN_TO_ACCESS_SECTION).toContain(MEMORY_DRIFT_CAVEAT)
  })
})

describe("TRUSTING_RECALL_SECTION", () => {
  test("starts with 'Before recommending from memory'", () => {
    expect(TRUSTING_RECALL_SECTION[0]).toBe(
      "## Before recommending from memory",
    )
  })

  test("contains verification guidance", () => {
    const joined = TRUSTING_RECALL_SECTION.join("\n")
    expect(joined).toContain("check the file exists")
    expect(joined).toContain("grep for it")
  })
})

describe("MEMORY_FRONTMATTER_EXAMPLE", () => {
  test("contains frontmatter markers", () => {
    const joined = MEMORY_FRONTMATTER_EXAMPLE.join("\n")
    expect(joined).toContain("---")
    expect(joined).toContain("name:")
    expect(joined).toContain("description:")
    expect(joined).toContain("type:")
  })

  test("lists all memory types in the type field", () => {
    const joined = MEMORY_FRONTMATTER_EXAMPLE.join("\n")
    expect(joined).toContain("user, feedback, project, reference")
  })
})
