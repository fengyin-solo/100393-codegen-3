<template>
  <section class="page" data-module="consultation">
    <header class="page-head">
      <div>
        <h2>阈值会诊队列</h2>
        <p class="page-desc">
          形变观测提交后自动生成会诊单，观测人逐项填写采纳或复测理由，人工结论优先、自动建议留作对照；
          状态依次经过待判定→会诊→复测→校核，越过阶段即拒绝。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="runBackfill">旧记录补算</button>
        <button class="btn" type="button" @click="exportRows">导出会诊清单</button>
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
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="select(row)">
              {{ selectedId === Number(row.id) ? '收起' : '处理' }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">
            暂无会诊单：登记形变观测后自动生成，或用「旧记录补算」按当时有效基线补建
          </td>
        </tr>
      </tbody>
    </table>

    <section v-if="selected" class="detail-card">
      <h3>
        会诊单 {{ selected['会诊编号'] }} · 记录 {{ selected['记录编号'] }} · 状态「{{ selected.status }}」
      </h3>
      <p class="detail-meta">
        <span>隐患点：{{ selected['隐患点编号'] }}</span>
        <span>观测日期：{{ selected['观测日期'] }}</span>
        <span>观测人：{{ selected['观测人'] }}</span>
        <span>来源：{{ selected['来源'] }}</span>
        <span>基线来源：{{ selected['基线来源'] }}</span>
        <span>版本：{{ selected['版本'] }}</span>
      </p>
      <p class="panel-tip">
        自动建议「{{ selected['自动建议'] }}」仅作对照，人工逐项结论优先；原始观测值冻结，复测值另存新版本。
      </p>

      <table class="data-table">
        <thead>
          <tr>
            <th>项目</th>
            <th>原始值</th>
            <th>自动等级</th>
            <th>结论</th>
            <th>理由</th>
            <th>复测值</th>
            <th>复测等级</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in items" :key="item.key">
            <td>{{ item.key }}（{{ item.unit }}）</td>
            <td>{{ selected[`${item.key}值`] }}</td>
            <td>{{ selected[`${item.key}等级`] }}</td>
            <td>
              <template v-if="selected.status === '待判定'">
                <label class="radio-item">
                  <input v-model="decisions[item.key].结论" type="radio" value="采纳" />采纳
                </label>
                <label class="radio-item">
                  <input v-model="decisions[item.key].结论" type="radio" value="复测" />复测
                </label>
              </template>
              <template v-else>{{ selected[`结论_${item.key}`] || '—' }}</template>
            </td>
            <td>
              <input
                v-if="selected.status === '待判定'"
                v-model="decisions[item.key].理由"
                :placeholder="`填写${item.key}的采纳或复测理由`"
              />
              <template v-else>{{ selected[`理由_${item.key}`] || '—' }}</template>
            </td>
            <td>
              <input
                v-if="selected.status === '会诊' && selected[`结论_${item.key}`] === '复测'"
                v-model="remeasureValues[item.key]"
                :placeholder="`复测${item.key}（${item.unit}）`"
              />
              <template v-else>{{ selected[`复测值_${item.key}`] || '—' }}</template>
            </td>
            <td>{{ selected[`复测等级_${item.key}`] || '—' }}</td>
          </tr>
        </tbody>
      </table>

      <div class="stage-bar">
        <button v-if="selected.status === '待判定'" class="btn primary" type="button" @click="submitReview">
          提交会诊结论
        </button>
        <button v-else-if="selected.status === '会诊'" class="btn primary" type="button" @click="submitRemeasure">
          {{ hasRemeasureItem ? '登记复测结果' : '确认无复测项' }}
        </button>
        <button v-else-if="selected.status === '复测'" class="btn primary" type="button" @click="submitVerify">
          完成校核
        </button>
        <span v-else class="panel-tip">
          已由 {{ selected['校核人'] }} 于 {{ selected['校核日期'] }} 校核，最终等级「{{ selected['最终等级'] }}」
          <template v-if="selected['加测编号']">，已生成裂缝加测单 {{ selected['加测编号'] }}</template>
        </span>
      </div>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条会诊单</span>
      <span v-if="infoMessage" class="ok-text">{{ infoMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  backfillConsultations,
  completeConsultVerification,
  downloadEntries,
  listEntries,
  registerRemeasure,
  submitConsultReview,
} from '@/api/local-service'
import { CONSULT_ITEMS } from '@/data/baselines'
import type { ConsultItemKey } from '@/data/baselines'
import type { EntryRow } from '@/data/types'
import { useSessionStore } from '@/stores/session'

const store = useSessionStore()
const items = CONSULT_ITEMS
const columns = ['会诊编号', '记录编号', '隐患点编号', '观测日期', '自动建议', '最终等级', '来源', '版本']
const statuses = ['待判定', '会诊', '复测', '校核']
const filterFields = ['会诊编号', '记录编号', '隐患点编号']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const infoMessage = ref('')
const filters = ref<Record<string, string>>({})
const selectedId = ref<number | null>(null)

const decisions = reactive<Record<ConsultItemKey, { 结论: string; 理由: string }>>({
  位移: { 结论: '', 理由: '' },
  裂缝宽度: { 结论: '', 理由: '' },
  速率: { 结论: '', 理由: '' },
})
const remeasureValues = reactive<Record<ConsultItemKey, string>>({ 位移: '', 裂缝宽度: '', 速率: '' })

const stats = computed(() =>
  statuses.map((status) => ({
    label: `${status}数`,
    value: rows.value.filter((row) => String(row.status) === status).length,
  })),
)
const statusSummary = computed(() =>
  statuses.map((status) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)
const selected = computed(() => rows.value.find((row) => Number(row.id) === selectedId.value) ?? null)
const hasRemeasureItem = computed(() =>
  selected.value
    ? items.some((item) => selected.value?.[`结论_${item.key}`] === '复测')
    : false,
)

function resetForms() {
  for (const item of items) {
    decisions[item.key] = { 结论: '', 理由: '' }
    remeasureValues[item.key] = ''
  }
}

function select(row: EntryRow) {
  if (selectedId.value === Number(row.id)) {
    selectedId.value = null
    return
  }
  selectedId.value = Number(row.id)
  resetForms()
}

function handleResult(result: { ok: boolean; message: string }) {
  reload()
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  infoMessage.value = result.message
}

function submitReview() {
  if (!selected.value) return
  handleResult(
    submitConsultReview(Number(selected.value.id), Number(selected.value['版本']), decisions, store.operator),
  )
}

function submitRemeasure() {
  if (!selected.value) return
  handleResult(
    registerRemeasure(Number(selected.value.id), Number(selected.value['版本']), remeasureValues, store.operator),
  )
}

function submitVerify() {
  if (!selected.value) return
  handleResult(
    completeConsultVerification(Number(selected.value.id), Number(selected.value['版本']), store.operator),
  )
}

function runBackfill() {
  handleResult(backfillConsultations())
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries('consultation')
}

function reload() {
  errorMessage.value = ''
  infoMessage.value = ''
  try {
    const payload = listEntries('consultation', filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '会诊队列读取失败'
  }
}

onMounted(reload)
</script>
