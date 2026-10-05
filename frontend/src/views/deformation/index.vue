<template>
  <section class="page" data-module="deformation">
    <header class="page-head">
      <div>
        <h2>形变观测管理</h2>
        <p class="page-desc">维护形变记录，围绕记录编号、隐患点编号、观测日期、裂缝宽度做登记、筛选与状态流转。登记观测会自动生成阈值会诊单。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="toggleCreate">登记形变记录</button>
        <button class="btn" type="button" @click="exportRows">导出形变观测清单</button>
      </div>
    </header>

    <form v-if="showCreate" class="create-panel" @submit.prevent="submitCreate">
      <h3>登记形变观测（提交后自动生成阈值会诊单，裂缝或速率越限将同步生成裂缝加测待办）</h3>
      <div class="create-grid">
        <label class="filter-item">
          <span>隐患点编号</span>
          <input v-model="createForm.隐患点编号" placeholder="如 HAZA-0001" required />
        </label>
        <label class="filter-item">
          <span>观测日期</span>
          <input v-model="createForm.观测日期" type="date" required />
        </label>
        <label class="filter-item">
          <span>水平位移量(mm)</span>
          <input v-model.number="createForm.水平位移量" type="number" min="0" step="0.1" required />
        </label>
        <label class="filter-item">
          <span>垂直位移量(mm)</span>
          <input v-model.number="createForm.垂直位移量" type="number" min="0" step="0.1" required />
        </label>
        <label class="filter-item">
          <span>裂缝宽度(mm)</span>
          <input v-model.number="createForm.裂缝宽度" type="number" min="0" step="0.1" required />
        </label>
        <label class="filter-item">
          <span>变化速率(mm/d)</span>
          <input v-model.number="createForm.变化速率" type="number" min="0" step="0.1" required />
        </label>
        <label class="filter-item">
          <span>观测人</span>
          <input v-model="createForm.观测人" placeholder="观测人姓名" required />
        </label>
      </div>
      <div class="create-actions">
        <button class="btn primary" type="submit">提交观测</button>
        <button class="btn ghost" type="button" @click="toggleCreate">取消</button>
      </div>
    </form>

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
            <button class="link" type="button" @click="startConsultation(row)">发起会诊</button>
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
          <td :colspan="columns.length + 2" class="empty-state">暂无形变观测数据，可先登记形变记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条形变观测记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-if="okMessage" class="ok-text">{{ okMessage }}</span>
    </footer>
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
import { createConsultationForRecord, submitObservation } from '@/api/consultation-service'
import { useSessionStore } from '@/stores/session'
import type { EntryRow } from '@/data/types'

const store = useSessionStore()
const meta = moduleMeta('deformation')
const columns = ["记录编号", "隐患点编号", "观测日期", "裂缝宽度", "水平位移量", "垂直位移量", "变化速率", "观测人", "记录状态"]
const actions = ["提交校核", "确认校核", "标记异常"]
const statuses = ["已观测", "待校核", "已校核", "异常值", "需复测"]
const stats = [{"label": "本月观测次数", "value": 0}, {"label": "异常记录数", "value": 0}, {"label": "待校核记录", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const okMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const showCreate = ref(false)
const createForm = ref(freshCreateForm())
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function freshCreateForm() {
  return { 隐患点编号: '', 观测日期: '', 水平位移量: 0, 垂直位移量: 0, 裂缝宽度: 0, 变化速率: 0, 观测人: '' }
}

function toggleCreate() {
  showCreate.value = !showCreate.value
  errorMessage.value = ''
}

function submitCreate() {
  errorMessage.value = ''
  okMessage.value = ''
  const result = submitObservation({ ...createForm.value }, store.operator)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  okMessage.value = result.message
  createForm.value = freshCreateForm()
  showCreate.value = false
  reload()
}

function startConsultation(row: EntryRow) {
  errorMessage.value = ''
  okMessage.value = ''
  const result = createConsultationForRecord(Number(row.id), store.operator)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  okMessage.value = result.message
  reload()
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  okMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  okMessage.value = result.message
  reload()
}

function reload() {
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '形变观测列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.create-panel {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px 16px;
  margin-bottom: 12px;
}
.create-panel h3 { margin: 0 0 10px; font-size: 14px; }
.create-grid { display: flex; flex-wrap: wrap; gap: 10px; }
.create-actions { margin-top: 10px; display: flex; gap: 8px; }
.ok-text { color: #15803d; }
</style>
