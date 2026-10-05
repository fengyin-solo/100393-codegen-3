<template>
  <section class="page" data-module="consultation">
    <header class="page-head">
      <div>
        <h2>阈值会诊队列</h2>
        <p class="page-desc">
          形变观测录入位移、裂缝宽度、速率后按当时有效基线自动分级；观测人逐项填写采纳或复测理由，
          原始观测值只读留痕。流程依次经过待判定→会诊→复测→校核，越过阶段即拒绝。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出会诊清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stageCounts" :key="item.stage" class="stat-card">
        <span class="stat-label">{{ item.stage }}</span>
        <strong class="stat-value">{{ item.count }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">冲突标记（人工与自动不一致）</span>
        <strong class="stat-value">{{ conflictCount }}</strong>
      </article>
    </div>

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
          <th>当前阶段</th>
          <th>版本</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)" :class="{ 'row-active': selectedId === Number(row.id) }">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td>v{{ row.version }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="select(row)">
              {{ selectedId === Number(row.id) ? '收起' : '处理' }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">
            暂无会诊单：在形变观测页登记观测或对历史记录发起会诊后自动生成
          </td>
        </tr>
      </tbody>
    </table>

    <section v-if="selected" class="detail-panel">
      <h3>
        会诊单 {{ selected['会诊单号'] }}（记录 {{ selected['记录编号'] }} · 当前阶段「{{ selected.status }}」 · v{{ selected.version }}）
        <span v-if="selected.abnormal" class="conflict-badge">冲突标记：最终分级与自动建议不一致</span>
      </h3>

      <div class="detail-grid">
        <div>
          <h4>原始观测值（只读，不覆盖）</h4>
          <p>水平位移 {{ selected['原始水平位移'] }}mm · 垂直位移 {{ selected['原始垂直位移'] }}mm</p>
          <p>裂缝宽度 {{ selected['原始裂缝宽度'] }}mm · 速率 {{ selected['原始速率'] }}mm/d</p>
          <p>观测人 {{ selected['观测人'] }} · 观测日期 {{ selected['观测日期'] }}</p>
        </div>
        <div>
          <h4>阈值基线快照</h4>
          <p>基线 {{ selected['基线编号'] }}（{{ selected['基线生效日期'] }} 起生效）</p>
          <p>{{ selected['基线来源'] }}</p>
        </div>
      </div>

      <table class="data-table item-table">
        <thead>
          <tr>
            <th>判定项</th><th>观测值</th><th>阈值(注意/警示/警戒)</th><th>自动建议</th>
            <th>人工判定</th><th>理由</th><th>复测值</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in itemRows" :key="item.item">
            <td>{{ item.item }}</td>
            <td>{{ item.original }}{{ item.unit }}</td>
            <td>{{ item.tripleText }}</td>
            <td>{{ item.suggest }}</td>
            <td>{{ item.decision || '—' }}</td>
            <td>{{ item.reason || '—' }}</td>
            <td>{{ item.remeasure === '' ? '—' : `${item.remeasure}${item.unit}` }}</td>
          </tr>
        </tbody>
      </table>

      <div v-if="selected.status === '待判定'" class="stage-form">
        <h4>逐项判定：自动建议仅供参考，人工判定优先，但每项必须写明采纳或复测理由</h4>
        <div v-for="item in itemRows" :key="item.item" class="decision-item">
          <span class="decision-label">{{ item.item }}（建议 {{ item.suggest }}）</span>
          <label><input v-model="decisionForm[item.item].结论" type="radio" :name="`decision-${item.item}`" value="采纳" /> 采纳</label>
          <label><input v-model="decisionForm[item.item].结论" type="radio" :name="`decision-${item.item}`" value="复测" /> 复测</label>
          <input v-model="decisionForm[item.item].理由" class="reason-input" :placeholder="`${item.item}的采纳或复测理由（必填）`" />
        </div>
        <button class="btn primary" type="button" @click="submitDecisionForm">提交逐项判定（进入会诊）</button>
      </div>

      <div v-else-if="selected.status === '会诊'" class="stage-form">
        <p>逐项判定已提交。下一步进入复测阶段：有复测项则录入复测值，无复测项直接确认。</p>
        <button class="btn primary" type="button" @click="enterRemeasure">进入复测阶段</button>
      </div>

      <div v-else-if="selected.status === '复测'" class="stage-form">
        <template v-if="remeasureItems.length">
          <div v-for="item in remeasureItems" :key="item" class="decision-item">
            <span class="decision-label">{{ item }}复测值（原始 {{ itemOriginal(item) }}）</span>
            <input v-model.number="remeasureValues[item]" type="number" min="0" step="0.1" :placeholder="`录入${item}复测值`" />
          </div>
        </template>
        <p v-else>全部采纳自动建议，无复测项。</p>
        <input v-model="remeasureNote" class="reason-input" placeholder="复测说明（选填）" />
        <button class="btn primary" type="button" @click="submitRemeasureForm">提交复测结果（进入校核）</button>
      </div>

      <div v-else class="stage-form">
        <p>
          流程已走完，最终分级「{{ selected['最终分级'] }}」（自动综合建议「{{ selected['自动综合建议'] }}」）。
          {{ selected.abnormal ? '人工判定优先，与自动建议不一致已打冲突标记。' : '人工判定与自动建议一致。' }}
        </p>
        <p v-if="selected['复测说明']">复测说明：{{ selected['复测说明'] }}</p>
      </div>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条会诊单</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-if="okMessage" class="ok-text">{{ okMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { downloadEntries, listEntries } from '@/api/local-service'
import {
  CONSULT_STAGES,
  JUDGE_ITEMS,
  advanceToRemeasure,
  submitDecisions,
  submitRemeasure,
  type ItemDecision,
  type JudgeItem,
} from '@/api/consultation-service'
import { useSessionStore } from '@/stores/session'
import type { ActionResult, EntryRow } from '@/data/types'

const store = useSessionStore()
const MODULE_KEY = 'consultation'
const columns = ['会诊单号', '记录编号', '隐患点编号', '观测日期', '观测人', '自动综合建议', '最终分级']
const filterFields = ['会诊单号', '记录编号', '隐患点编号']

// 判定项 → 会诊单行上的展示字段
const ITEM_VIEW: Record<
  JudgeItem,
  { original: string; suggest: string; decision: string; reason: string; remeasure: string; triple: [string, string, string]; unit: string }
> = {
  位移: { original: '位移取值', suggest: '位移建议', decision: '位移判定', reason: '位移理由', remeasure: '位移复测值', triple: ['位移阈值注意', '位移阈值警示', '位移阈值警戒'], unit: 'mm' },
  裂缝宽度: { original: '原始裂缝宽度', suggest: '裂缝建议', decision: '裂缝判定', reason: '裂缝理由', remeasure: '裂缝复测值', triple: ['裂缝阈值注意', '裂缝阈值警示', '裂缝阈值警戒'], unit: 'mm' },
  速率: { original: '原始速率', suggest: '速率建议', decision: '速率判定', reason: '速率理由', remeasure: '速率复测值', triple: ['速率阈值注意', '速率阈值警示', '速率阈值警戒'], unit: 'mm/d' },
}

const rows = ref<EntryRow[]>([])
const total = ref(0)
const filters = ref<Record<string, string>>({})
const errorMessage = ref('')
const okMessage = ref('')
const selectedId = ref<number | null>(null)

const decisionForm = ref<Record<JudgeItem, { 结论: '' | '采纳' | '复测'; 理由: string }>>(freshDecisions())
const remeasureValues = ref<Partial<Record<JudgeItem, number>>>({})
const remeasureNote = ref('')

const selected = computed(() => rows.value.find((row) => Number(row.id) === selectedId.value) ?? null)

const stageCounts = computed(() =>
  CONSULT_STAGES.map((stage) => ({
    stage,
    count: rows.value.filter((row) => String(row.status) === stage).length,
  })),
)
const conflictCount = computed(() => rows.value.filter((row) => row.abnormal).length)

const itemRows = computed(() => {
  const ticket = selected.value
  if (!ticket) {
    return []
  }
  return JUDGE_ITEMS.map((item) => {
    const view = ITEM_VIEW[item]
    return {
      item,
      unit: view.unit,
      original: ticket[view.original],
      tripleText: `${ticket[view.triple[0]]}/${ticket[view.triple[1]]}/${ticket[view.triple[2]]}`,
      suggest: String(ticket[view.suggest] ?? '—'),
      decision: String(ticket[view.decision] ?? ''),
      reason: String(ticket[view.reason] ?? ''),
      remeasure: ticket[view.remeasure],
    }
  })
})

const remeasureItems = computed(() =>
  itemRows.value.filter((row) => row.decision === '复测').map((row) => row.item),
)

function freshDecisions() {
  return {
    位移: { 结论: '' as '' | '采纳' | '复测', 理由: '' },
    裂缝宽度: { 结论: '' as '' | '采纳' | '复测', 理由: '' },
    速率: { 结论: '' as '' | '采纳' | '复测', 理由: '' },
  }
}

function itemOriginal(item: JudgeItem) {
  const view = ITEM_VIEW[item]
  const ticket = selected.value
  return ticket ? `${ticket[view.original]}${view.unit}` : ''
}

function select(row: EntryRow) {
  if (selectedId.value === Number(row.id)) {
    selectedId.value = null
    return
  }
  selectedId.value = Number(row.id)
  decisionForm.value = freshDecisions()
  remeasureValues.value = {}
  remeasureNote.value = ''
  errorMessage.value = ''
  okMessage.value = ''
}

function handle(result: ActionResult) {
  if (!result.ok) {
    errorMessage.value = result.message
    okMessage.value = ''
    reload()
    return
  }
  okMessage.value = result.message
  errorMessage.value = ''
  reload()
}

function submitDecisionForm() {
  const ticket = selected.value
  if (!ticket) return
  handle(
    submitDecisions(
      Number(ticket.id),
      decisionForm.value as Record<JudgeItem, ItemDecision>,
      Number(ticket.version),
      store.operator,
    ),
  )
}

function enterRemeasure() {
  const ticket = selected.value
  if (!ticket) return
  handle(advanceToRemeasure(Number(ticket.id), Number(ticket.version), store.operator))
}

function submitRemeasureForm() {
  const ticket = selected.value
  if (!ticket) return
  handle(
    submitRemeasure(
      Number(ticket.id),
      remeasureValues.value,
      remeasureNote.value,
      Number(ticket.version),
      store.operator,
    ),
  )
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(MODULE_KEY)
}

function reload() {
  try {
    const payload = listEntries(MODULE_KEY, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '会诊队列读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.detail-panel {
  margin-top: 12px;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px 16px;
}
.detail-panel h3 { margin: 0 0 8px; font-size: 15px; }
.detail-panel h4 { margin: 8px 0 6px; font-size: 13px; color: var(--muted); }
.detail-grid { display: flex; gap: 32px; font-size: 13px; }
.detail-grid p { margin: 2px 0; }
.item-table { margin-top: 8px; }
.stage-form { margin-top: 12px; display: flex; flex-direction: column; gap: 8px; font-size: 13px; }
.decision-item { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.decision-label { min-width: 220px; }
.reason-input { flex: 1; min-width: 240px; padding: 4px 8px; border: 1px solid var(--border); border-radius: 6px; }
.conflict-badge {
  margin-left: 8px;
  font-size: 12px;
  color: #b42318;
  background: #fee4e2;
  border-radius: 999px;
  padding: 2px 10px;
}
.row-active td { background: #eef4ff; }
.ok-text { color: #15803d; }
</style>
