<template>
  <section class="page" data-module="crack">
    <header class="page-head">
      <div>
        <h2>裂缝监测管理</h2>
        <p class="page-desc">维护裂缝测点，围绕测点编号、隐患点编号、裂缝编号、初始宽度做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记裂缝测点</button>
        <button class="btn" type="button" @click="exportRows">导出裂缝监测清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无裂缝监测数据，可先登记裂缝测点</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条裂缝监测记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <section class="extra-panel">
      <header class="page-head">
        <div>
          <h2>裂缝加测待办</h2>
          <p class="page-desc">
            形变观测会诊中裂缝宽度或速率达注意级及以上时同步生成。阶段必须依次经过待判定→会诊→复测→校核，越过阶段即拒绝。
          </p>
        </div>
      </header>

      <p class="status-legend">
        <span v-for="item in extraStageSummary" :key="item.stage" class="legend-item">
          {{ item.stage }}：{{ item.count }}
        </span>
      </p>

      <table class="data-table">
        <thead>
          <tr>
            <th v-for="column in extraColumns" :key="column">{{ column }}</th>
            <th>当前阶段</th>
            <th>版本</th>
            <th>处理备注</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="todo in extraTodos" :key="String(todo.id)">
            <td v-for="column in extraColumns" :key="column">{{ todo[column] ?? '—' }}</td>
            <td>{{ todo.status }}</td>
            <td>v{{ todo.version }}</td>
            <td>
              <input
                v-model="extraNotes[Number(todo.id)]"
                class="note-input"
                :placeholder="String(todo['处理备注'] ?? '') || '推进备注（选填）'"
                :disabled="todo.status === '校核'"
              />
            </td>
            <td class="row-actions">
              <button
                v-if="nextExtraStage(todo)"
                class="link"
                type="button"
                @click="advanceTodo(todo)"
              >
                推进至{{ nextExtraStage(todo) }}
              </button>
              <span v-else>已完结</span>
            </td>
          </tr>
          <tr v-if="!extraTodos.length">
            <td :colspan="extraColumns.length + 4" class="empty-state">暂无加测待办</td>
          </tr>
        </tbody>
      </table>

      <footer class="page-foot">
        <span>共 {{ extraTodos.length }} 条加测待办</span>
        <span v-if="extraError" class="error-text">{{ extraError }}</span>
        <span v-if="extraOk" class="ok-text">{{ extraOk }}</span>
      </footer>
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { CONSULT_STAGES, advanceExtra, nextStage } from '@/api/consultation-service'
import { useSessionStore } from '@/stores/session'
import type { EntryRow } from '@/data/types'

const store = useSessionStore()
const meta = moduleMeta('crack')
const columns = ["测点编号", "隐患点编号", "裂缝编号", "初始宽度", "当前宽度", "变化速率", "监测人", "测点状态"]
const actions = ["记录数据", "标记加速", "确认稳定"]
const statuses = ["正常", "加速发展", "趋于稳定", "已修复", "已废弃"]
const stats = [{"label": "测点总数", "value": 0}, {"label": "加速发展数", "value": 0}, {"label": "正常测点数", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 裂缝加测待办：形变会诊同步生成，走 待判定→会诊→复测→校核 的严格阶段机
const extraColumns = ["加测单号", "会诊单号", "记录编号", "隐患点编号", "加测原因", "触发级别", "处理人"]
const extraTodos = ref<EntryRow[]>([])
const extraNotes = ref<Record<number, string>>({})
const extraError = ref('')
const extraOk = ref('')
const extraStageSummary = computed(() =>
  CONSULT_STAGES.map((stage) => ({
    stage,
    count: extraTodos.value.filter((todo) => String(todo.status) === stage).length,
  })),
)

function nextExtraStage(todo: EntryRow) {
  return nextStage(String(todo.status))
}

function advanceTodo(todo: EntryRow) {
  extraError.value = ''
  extraOk.value = ''
  const target = nextStage(String(todo.status))
  if (!target) {
    return
  }
  const result = advanceExtra(
    Number(todo.id),
    target,
    Number(todo.version),
    store.operator,
    extraNotes.value[Number(todo.id)] ?? '',
  )
  if (!result.ok) {
    extraError.value = result.message
    return
  }
  extraOk.value = result.message
  extraNotes.value[Number(todo.id)] = ''
  loadExtraTodos()
}

function loadExtraTodos() {
  try {
    extraTodos.value = listEntries('crack_extra', {}).items
  } catch (error) {
    extraError.value = error instanceof Error ? error.message : '加测待办读取失败'
  }
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '裂缝测点登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '裂缝监测列表读取失败'
  }
  loadExtraTodos()
}

onMounted(reload)
</script>

<style scoped>
.extra-panel {
  margin-top: 20px;
  border-top: 2px solid var(--border);
  padding-top: 8px;
}
.note-input {
  width: 180px;
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 12px;
}
.ok-text { color: #15803d; }
</style>
