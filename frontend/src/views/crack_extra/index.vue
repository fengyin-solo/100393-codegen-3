<template>
  <section class="page" data-module="crack_extra">
    <header class="page-head">
      <div>
        <h2>裂缝加测待办</h2>
        <p class="page-desc">
          形变会诊校核达到警示级及以上时同步生成的裂缝监测加测单；状态依次经过待判定→会诊→复测→校核，
          越过阶段即拒绝，并发提交仅保留首个版本。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出加测单清单</button>
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
            暂无加测待办：形变会诊校核达到警示级及以上时自动同步生成
          </td>
        </tr>
      </tbody>
    </table>

    <section v-if="selected" class="detail-card">
      <h3>加测单 {{ selected['加测编号'] }} · 状态「{{ selected.status }}」</h3>
      <p class="detail-meta">
        <span>来源会诊单：{{ selected['来源会诊编号'] }}</span>
        <span>隐患点：{{ selected['隐患点编号'] }}</span>
        <span>测点：{{ selected['测点编号'] }}</span>
        <span>要求完成：{{ selected['要求完成日期'] }}</span>
        <span>版本：{{ selected['版本'] }}</span>
      </p>
      <p class="panel-tip">加测原因：{{ selected['加测原因'] }}</p>

      <div v-if="selected.status === '待判定'" class="stage-form">
        <label class="form-item">
          <span>监测人（必填）</span>
          <input v-model="form.监测人" placeholder="指定负责加测的监测人" />
        </label>
        <label class="form-item">
          <span>处理备注</span>
          <input v-model="form.处理备注" placeholder="会诊意见、加测安排等" />
        </label>
        <button class="btn primary" type="button" @click="advance">提交会诊</button>
      </div>

      <div v-else-if="selected.status === '会诊'" class="stage-form">
        <label class="form-item">
          <span>加测结果（必填）</span>
          <input v-model="form.加测结果" placeholder="如：当前宽度 19.2mm" />
        </label>
        <label class="form-item">
          <span>处理备注</span>
          <input v-model="form.处理备注" placeholder="复测情况说明" />
        </label>
        <button class="btn primary" type="button" @click="advance">登记复测</button>
      </div>

      <div v-else-if="selected.status === '复测'" class="stage-form">
        <span class="panel-tip">加测结果：{{ selected['加测结果'] }}，确认无误后完成校核。</span>
        <button class="btn primary" type="button" @click="advance">完成校核</button>
      </div>

      <p v-else class="panel-tip">
        已校核办结。监测人：{{ selected['监测人'] }}；加测结果：{{ selected['加测结果'] }}；备注：{{
          selected['处理备注'] || '—'
        }}
      </p>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条加测单</span>
      <span v-if="infoMessage" class="ok-text">{{ infoMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import { advanceCrackExtra, downloadEntries, listEntries } from '@/api/local-service'
import type { EntryRow } from '@/data/types'
import { useSessionStore } from '@/stores/session'

const store = useSessionStore()
const columns = ['加测编号', '来源会诊编号', '隐患点编号', '测点编号', '加测原因', '要求完成日期', '监测人', '处理备注']
const statuses = ['待判定', '会诊', '复测', '校核']
const filterFields = ['加测编号', '来源会诊编号', '隐患点编号']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const infoMessage = ref('')
const filters = ref<Record<string, string>>({})
const selectedId = ref<number | null>(null)
const form = reactive({ 监测人: '', 加测结果: '', 处理备注: '' })

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

function select(row: EntryRow) {
  if (selectedId.value === Number(row.id)) {
    selectedId.value = null
    return
  }
  selectedId.value = Number(row.id)
  form.监测人 = String(row['监测人'] || '') || store.operator
  form.加测结果 = ''
  form.处理备注 = ''
}

function advance() {
  if (!selected.value) return
  const result = advanceCrackExtra(Number(selected.value.id), Number(selected.value['版本']), { ...form })
  reload()
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  infoMessage.value = result.message
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries('crack_extra')
}

function reload() {
  errorMessage.value = ''
  infoMessage.value = ''
  try {
    const payload = listEntries('crack_extra', filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '加测单列表读取失败'
  }
}

onMounted(reload)
</script>
