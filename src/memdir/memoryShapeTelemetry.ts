import type { MemoryHeader } from './memoryScan.js'
import type { MemoryScope } from '../utils/memoryFileDetection.js'
import { logEvent } from '../services/analytics/index.js'
import { memoryAgeDays } from './memoryAge.js'

/**
 * Log telemetry about the shape of memory recall: how many candidates
 * were available, how many were selected, and the age distribution of
 * both sets. Fires even on empty selection (selection-rate needs the
 * denominator, and -1 ages distinguish "ran, picked nothing" from
 * "never ran").
 */
export function logMemoryRecallShape(
  memories: MemoryHeader[],
  selected: MemoryHeader[],
): void {
  const candidateAges = memories.map(m => memoryAgeDays(m.mtimeMs))
  const selectedAges = selected.map(m => memoryAgeDays(m.mtimeMs))

  logEvent('tengu_memory_recall_shape', {
    candidate_count: memories.length,
    selected_count: selected.length,
    candidate_age_min:
      candidateAges.length > 0 ? Math.min(...candidateAges) : -1,
    candidate_age_max:
      candidateAges.length > 0 ? Math.max(...candidateAges) : -1,
    candidate_age_median: median(candidateAges),
    selected_age_min:
      selectedAges.length > 0 ? Math.min(...selectedAges) : -1,
    selected_age_max:
      selectedAges.length > 0 ? Math.max(...selectedAges) : -1,
    selected_age_median: median(selectedAges),
    selected_types: selected
      .map(m => m.type ?? 'unknown')
      .join(','),
  })
}

/**
 * Log telemetry about memory writes: which tool, the scope (personal/team),
 * and basic shape of the write (new file vs edit, file extension).
 */
export function logMemoryWriteShape(
  toolName: string,
  _toolInput: Record<string, unknown>,
  filePath: string,
  scope: MemoryScope,
): void {
  const isEntrypoint = filePath.endsWith('MEMORY.md')

  logEvent('tengu_memory_write_shape', {
    tool: toolName,
    scope,
    is_entrypoint: isEntrypoint,
    file_ext: filePath.endsWith('.md') ? '.md' : 'other',
  })
}

function median(values: number[]): number {
  if (values.length === 0) return -1
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}
