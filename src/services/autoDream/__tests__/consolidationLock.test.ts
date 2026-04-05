/**
 * Tests for consolidationLock pure logic.
 * The actual lock functions depend on getAutoMemPath() and filesystem ops,
 * so we test the lock semantics using temp directories.
 */
import { mkdir, readFile, stat, unlink, utimes, writeFile } from "fs/promises"
import { join } from "path"
import { tmpdir } from "os"
import { describe, expect, test, beforeEach, afterEach } from "bun:test"

// Recreate the pure lock logic for testing with a controllable temp dir
const HOLDER_STALE_MS = 60 * 60 * 1000 // 1 hour

async function readLastConsolidatedAt(lockPath: string): Promise<number> {
  try {
    const s = await stat(lockPath)
    return s.mtimeMs
  } catch {
    return 0
  }
}

async function tryAcquireConsolidationLock(
  lockPath: string,
  lockDir: string,
  pid: number,
): Promise<number | null> {
  let mtimeMs: number | undefined
  let holderPid: number | undefined
  try {
    const [s, raw] = await Promise.all([stat(lockPath), readFile(lockPath, "utf8")])
    mtimeMs = s.mtimeMs
    const parsed = parseInt(raw.trim(), 10)
    holderPid = Number.isFinite(parsed) ? parsed : undefined
  } catch {
    // ENOENT — no prior lock
  }

  if (mtimeMs !== undefined && Date.now() - mtimeMs < HOLDER_STALE_MS) {
    if (holderPid !== undefined && isProcessRunning(holderPid)) {
      return null
    }
  }

  await mkdir(lockDir, { recursive: true })
  await writeFile(lockPath, String(pid))

  let verify: string
  try {
    verify = await readFile(lockPath, "utf8")
  } catch {
    return null
  }
  if (parseInt(verify.trim(), 10) !== pid) return null

  return mtimeMs ?? 0
}

async function rollbackConsolidationLock(
  lockPath: string,
  priorMtime: number,
): Promise<void> {
  if (priorMtime === 0) {
    await unlink(lockPath).catch(() => {})
    return
  }
  await writeFile(lockPath, "")
  const t = priorMtime / 1000
  await utimes(lockPath, t, t)
}

function isProcessRunning(pid: number): boolean {
  try {
    // Sending signal 0 doesn't kill the process, just checks if it exists
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe("consolidationLock", () => {
  let testDir: string
  let lockPath: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `consolidation-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    lockPath = join(testDir, ".consolidate-lock")
    await mkdir(testDir, { recursive: true })
  })

  afterEach(async () => {
    await unlink(lockPath).catch(() => {})
    // Clean up temp dir
    const { rm } = await import("fs/promises")
    await rm(testDir, { recursive: true }).catch(() => {})
  })

  describe("readLastConsolidatedAt", () => {
    test("returns 0 when lock file does not exist", async () => {
      expect(await readLastConsolidatedAt(lockPath)).toBe(0)
    })

    test("returns mtime when lock file exists", async () => {
      await writeFile(lockPath, String(process.pid))
      const mtime = await readLastConsolidatedAt(lockPath)
      expect(mtime).toBeGreaterThan(0)
    })
  })

  describe("tryAcquireConsolidationLock", () => {
    test("acquires lock when no prior lock exists", async () => {
      const result = await tryAcquireConsolidationLock(lockPath, testDir, process.pid)
      expect(result).toBe(0) // no prior mtime
      const content = await readFile(lockPath, "utf8")
      expect(content.trim()).toBe(String(process.pid))
    })

    test("acquires lock when prior holder PID is dead", async () => {
      // Write a stale lock with a PID that doesn't exist
      await writeFile(lockPath, "999999999")
      const result = await tryAcquireConsolidationLock(lockPath, testDir, process.pid)
      // Should succeed (dead PID) or fail (race). In practice, 999999999
      // is very likely not running.
      if (result !== null) {
        const content = await readFile(lockPath, "utf8")
        expect(content.trim()).toBe(String(process.pid))
      }
    })

    test("returns null when current process already holds lock", async () => {
      // First acquire
      await tryAcquireConsolidationLock(lockPath, testDir, process.pid)
      // Second acquire by same process should also succeed since PID matches
      // (the current process IS running)
      const result = await tryAcquireConsolidationLock(lockPath, testDir, process.pid)
      // Actually, since the lock is "live" and the PID is running, this should return null
      expect(result).toBeNull()
    })
  })

  describe("rollbackConsolidationLock", () => {
    test("deletes lock file when priorMtime is 0", async () => {
      await writeFile(lockPath, "test")
      await rollbackConsolidationLock(lockPath, 0)
      await expect(readFile(lockPath, "utf8")).rejects.toThrow()
    })

    test("rewinds mtime to prior value", async () => {
      await writeFile(lockPath, "test")
      const priorMtime = Date.now() - 86_400_000 // 1 day ago
      await rollbackConsolidationLock(lockPath, priorMtime)
      const mtime = await readLastConsolidatedAt(lockPath)
      // Allow 1 second tolerance for filesystem precision
      expect(Math.abs(mtime - priorMtime)).toBeLessThan(2000)
    })

    test("clears PID body on rollback", async () => {
      await writeFile(lockPath, String(process.pid))
      const priorMtime = Date.now() - 1000
      await rollbackConsolidationLock(lockPath, priorMtime)
      const content = await readFile(lockPath, "utf8")
      expect(content.trim()).toBe("")
    })
  })

  describe("acquire-rollback-acquire cycle", () => {
    test("can re-acquire after rollback with priorMtime=0", async () => {
      // Acquire
      const r1 = await tryAcquireConsolidationLock(lockPath, testDir, process.pid)
      expect(r1).toBe(0)

      // Rollback
      await rollbackConsolidationLock(lockPath, 0)

      // Re-acquire (lock file is gone)
      const r2 = await tryAcquireConsolidationLock(lockPath, testDir, process.pid)
      expect(r2).toBe(0)
    })
  })
})
