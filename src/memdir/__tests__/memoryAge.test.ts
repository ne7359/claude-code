import { describe, expect, test } from "bun:test"
import {
  memoryAgeDays,
  memoryAge,
  memoryFreshnessText,
  memoryFreshnessNote,
} from "../memoryAge"

describe("memoryAgeDays", () => {
  test("returns 0 for current timestamp", () => {
    expect(memoryAgeDays(Date.now())).toBe(0)
  })

  test("returns 0 for very recent timestamp (1 second ago)", () => {
    expect(memoryAgeDays(Date.now() - 1000)).toBe(0)
  })

  test("returns 1 for yesterday (24 hours ago)", () => {
    expect(memoryAgeDays(Date.now() - 86_400_000)).toBe(1)
  })

  test("returns 7 for a week ago", () => {
    expect(memoryAgeDays(Date.now() - 7 * 86_400_000)).toBe(7)
  })

  test("returns 30 for a month ago", () => {
    expect(memoryAgeDays(Date.now() - 30 * 86_400_000)).toBe(30)
  })

  test("clamps negative (future mtime) to 0", () => {
    expect(memoryAgeDays(Date.now() + 86_400_000)).toBe(0)
  })

  test("floor rounds partial days", () => {
    // 1.5 days ago
    expect(memoryAgeDays(Date.now() - 1.5 * 86_400_000)).toBe(1)
  })
})

describe("memoryAge", () => {
  test("returns 'today' for current timestamp", () => {
    expect(memoryAge(Date.now())).toBe("today")
  })

  test("returns 'yesterday' for 1 day ago", () => {
    expect(memoryAge(Date.now() - 86_400_000)).toBe("yesterday")
  })

  test("returns 'N days ago' for older", () => {
    expect(memoryAge(Date.now() - 2 * 86_400_000)).toBe("2 days ago")
    expect(memoryAge(Date.now() - 47 * 86_400_000)).toBe("47 days ago")
  })
})

describe("memoryFreshnessText", () => {
  test("returns empty string for today", () => {
    expect(memoryFreshnessText(Date.now())).toBe("")
  })

  test("returns empty string for yesterday", () => {
    expect(memoryFreshnessText(Date.now() - 86_400_000)).toBe("")
  })

  test("returns staleness warning for 2+ days", () => {
    const text = memoryFreshnessText(Date.now() - 2 * 86_400_000)
    expect(text).toContain("2 days old")
    expect(text).toContain("point-in-time")
    expect(text).toContain("Verify against current code")
  })

  test("includes age in days", () => {
    const text = memoryFreshnessText(Date.now() - 30 * 86_400_000)
    expect(text).toContain("30 days old")
  })
})

describe("memoryFreshnessNote", () => {
  test("returns empty string for fresh memory", () => {
    expect(memoryFreshnessNote(Date.now())).toBe("")
  })

  test("wraps stale warning in system-reminder tags", () => {
    const note = memoryFreshnessNote(Date.now() - 5 * 86_400_000)
    expect(note).toMatch(/^<system-reminder>/)
    expect(note).toMatch(/<\/system-reminder>\n$/)
    expect(note).toContain("5 days old")
  })
})
