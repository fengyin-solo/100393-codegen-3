import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
// v2：阈值/形变种子结构升级（生效日期、变化速率），旧 key 下的数据不再沿用。
const STORAGE_KEY = 'geohazard-monitor-prevention:entries:v2'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

// 写操作前先从 localStorage 刷新缓存：别的标签页已提交的内容能立刻看到，
// 配合会诊服务的版本号校验实现「并发提交仅保留首个版本」。
export function refreshFromStorage(): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }
  cache = readStorage()
}

// 事务包装：fn 里的多次 saveRows 只要有一步抛错，就把缓存和 localStorage
// 整体恢复到进入事务前的快照，保证「写入失败则整体回退」。
export function transact<T>(fn: () => T): T {
  refreshFromStorage()
  const snapshot = clone(allRows())
  try {
    return fn()
  } catch (error) {
    cache = snapshot
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot))
      }
    } catch {
      // 快照回写也失败时至少保证内存缓存已恢复，页面重载后以下次读取为准。
    }
    throw error
  }
}

export function storageKey(): string {
  return STORAGE_KEY
}
