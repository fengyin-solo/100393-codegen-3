import { gradeConsultation, gradeOf, maxGrade, composeDisplacement, resolveBand } from '@/data/baselines'
import type { ConsultItemKey, GradeLevel } from '@/data/baselines'
import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows, withTransaction } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  if (meta.strictSequence) {
    const flow = meta.statuses
    const currentIndex = flow.indexOf(current)
    const targetIndex = flow.indexOf(target)
    if (targetIndex !== currentIndex + 1) {
      return {
        ok: false,
        message: `${meta.entity}必须依次经过${flow.join('→')}，禁止从「${current}」越到「${target}」`,
      }
    }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}

// ===== 阈值会诊队列 =====
// 调用关系：观测提交(submitObservation) → 会诊(submitConsultReview) → 复测(registerRemeasure)
//   → 校核(completeConsultVerification) → 最终等级达警示级及以上时，同事务在裂缝监测侧
//   生成加测单(crack_extra)，加测单自身也按 待判定→会诊→复测→校核 逐级流转。
// 约定：
//   1. 自动建议只作对照，人工逐项结论（含复测实测值）优先，每项必须填写采纳或复测理由；
//   2. 原始观测值冻结在会诊单上，复测值另存字段、版本号递增，绝不覆盖原始值；
//   3. 旧记录没有阈值配置时，按观测日期匹配当时有效的基线版本补算（见 data/baselines.ts）；
//   4. 会诊单、加测单都带版本号，提交时校验，并发提交仅保留首个版本；
//   5. 跨模块多步写入一律走 withTransaction，任何一步失败整体回退。

const CONSULT_KEY = 'consultation'
const CRACK_EXTRA_KEY = 'crack_extra'
const CONSULT_FLOW = ['待判定', '会诊', '复测', '校核']
const ITEM_KEYS: ConsultItemKey[] = ['位移', '裂缝宽度', '速率']

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function nextCode(rows: EntryRow[], prefix: string): string {
  return `${prefix}-${String(nextId(rows)).padStart(4, '0')}`
}

function today(): string {
  const now = new Date()
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${mm}-${dd}`
}

function addDays(base: string, days: number): string {
  const date = new Date(`${base}T00:00:00`)
  date.setDate(date.getDate() + days)
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${mm}-${dd}`
}

function blankConsultRow(id: number, code: string): EntryRow {
  const row: EntryRow = {
    id,
    status: '待判定',
    pending: true,
    abnormal: false,
    会诊编号: code,
    记录编号: '',
    隐患点编号: '',
    观测日期: '',
    观测人: '',
    位移值: 0,
    裂缝宽度值: 0,
    速率值: 0,
    位移等级: '正常',
    裂缝宽度等级: '正常',
    速率等级: '正常',
    自动建议: '正常',
    最终等级: '',
    基线来源: '',
    来源: '观测提交',
    版本: 1,
    加测编号: '',
    会诊人: '',
    会诊日期: '',
    复测人: '',
    复测日期: '',
    校核人: '',
    校核日期: '',
  }
  for (const key of ITEM_KEYS) {
    row[`结论_${key}`] = ''
    row[`理由_${key}`] = ''
    row[`复测值_${key}`] = ''
    row[`复测等级_${key}`] = ''
  }
  return row
}

function updateDeformationStatus(recordCode: string, status: string): void {
  const rows = listRows('deformation')
  const index = rows.findIndex((row) => String(row['记录编号']) === recordCode)
  if (index < 0) {
    return
  }
  const next = [...rows]
  next[index] = { ...rows[index], status, 记录状态: status, pending: status !== '已校核' }
  saveRows('deformation', next)
}

function checkVersion(row: EntryRow, version: number, entity: string): ActionResult | null {
  if (Number(row['版本']) !== version) {
    return {
      ok: false,
      message: `该${entity}已存在更新的版本（当前版本 ${row['版本']}），并发提交仅保留首个版本，请刷新后重试`,
    }
  }
  return null
}

export type ObservationInput = {
  隐患点编号: string
  观测日期: string
  水平位移量: string
  垂直位移量: string
  裂缝宽度: string
  变化速率: string
  观测人: string
}

/** 观测提交：登记形变记录，并同事务生成待判定会诊单（含自动分级建议）。 */
export function submitObservation(input: ObservationInput): ActionResult {
  const hazard = input.隐患点编号.trim()
  const observeDate = input.观测日期.trim()
  const observer = input.观测人.trim()
  if (!hazard || !observeDate || !observer) {
    return { ok: false, message: '隐患点编号、观测日期、观测人都不能为空' }
  }
  const numbers = {
    水平位移量: Number(input.水平位移量),
    垂直位移量: Number(input.垂直位移量),
    裂缝宽度: Number(input.裂缝宽度),
    变化速率: Number(input.变化速率),
  }
  for (const [label, value] of Object.entries(numbers)) {
    if (!Number.isFinite(value) || value < 0) {
      return { ok: false, message: `${label}必须是不小于 0 的数字` }
    }
  }
  const deformationRows = listRows('deformation')
  const consultRows = listRows(CONSULT_KEY)
  const values: Record<ConsultItemKey, number> = {
    位移: composeDisplacement(numbers.水平位移量, numbers.垂直位移量),
    裂缝宽度: numbers.裂缝宽度,
    速率: numbers.变化速率,
  }
  const graded = gradeConsultation(values, hazard, observeDate, listRows('threshold'))
  const recordCode = nextCode(deformationRows, 'DEFO')
  const consultCode = nextCode(consultRows, 'CONS')
  const recordRow: EntryRow = {
    id: nextId(deformationRows),
    status: '已观测',
    pending: true,
    abnormal: graded.suggestion !== '正常',
    记录编号: recordCode,
    隐患点编号: hazard,
    观测日期: observeDate,
    裂缝宽度: numbers.裂缝宽度,
    水平位移量: numbers.水平位移量,
    垂直位移量: numbers.垂直位移量,
    变化速率: numbers.变化速率,
    观测人: observer,
    记录状态: '已观测',
  }
  const consultRow: EntryRow = {
    ...blankConsultRow(nextId(consultRows), consultCode),
    abnormal: graded.suggestion !== '正常',
    记录编号: recordCode,
    隐患点编号: hazard,
    观测日期: observeDate,
    观测人: observer,
    位移值: values.位移,
    裂缝宽度值: values.裂缝宽度,
    速率值: values.速率,
    位移等级: graded.grades.位移,
    裂缝宽度等级: graded.grades.裂缝宽度,
    速率等级: graded.grades.速率,
    自动建议: graded.suggestion,
    基线来源: graded.source,
    来源: '观测提交',
  }
  try {
    withTransaction(() => {
      saveRows('deformation', [...deformationRows, recordRow])
      saveRows(CONSULT_KEY, [...consultRows, consultRow])
    })
  } catch {
    return { ok: false, message: '观测提交写入失败，形变记录与会诊单已整体回退，请重试' }
  }
  return {
    ok: true,
    message: `已登记形变记录 ${recordCode}，并生成会诊单 ${consultCode}（待判定），自动建议「${graded.suggestion}」，${graded.source}`,
  }
}

export type ReviewDecision = { 结论: string; 理由: string }

/** 会诊：观测人对位移、裂缝宽度、速率逐项给出采纳或复测结论并附理由。 */
export function submitConsultReview(
  id: number,
  version: number,
  decisions: Record<ConsultItemKey, ReviewDecision>,
  operator: string,
): ActionResult {
  const rows = listRows(CONSULT_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的会诊单` }
  }
  const row = rows[index]
  if (row.status !== '待判定') {
    return {
      ok: false,
      message: `会诊单当前状态「${row.status}」，必须依次经过${CONSULT_FLOW.join('→')}，只有待判定阶段能提交会诊结论`,
    }
  }
  const conflict = checkVersion(row, version, '会诊单')
  if (conflict) {
    return conflict
  }
  for (const key of ITEM_KEYS) {
    const decision = decisions[key]
    if (!decision || (decision.结论 !== '采纳' && decision.结论 !== '复测')) {
      return { ok: false, message: `「${key}」必须选择采纳或复测` }
    }
    if (!decision.理由.trim()) {
      return { ok: false, message: `「${key}」必须填写${decision.结论}理由` }
    }
  }
  const updated: EntryRow = { ...row, status: '会诊', 版本: version + 1, 会诊人: operator, 会诊日期: today() }
  let needRemeasure = false
  for (const key of ITEM_KEYS) {
    updated[`结论_${key}`] = decisions[key].结论
    updated[`理由_${key}`] = decisions[key].理由.trim()
    if (decisions[key].结论 === '复测') {
      needRemeasure = true
    }
  }
  try {
    withTransaction(() => {
      const next = [...rows]
      next[index] = updated
      saveRows(CONSULT_KEY, next)
      if (needRemeasure) {
        updateDeformationStatus(String(row['记录编号']), '需复测')
      }
    })
  } catch {
    return { ok: false, message: '会诊结论写入失败，已整体回退，请重试' }
  }
  return {
    ok: true,
    message: `会诊结论已提交：人工逐项结论优先，自动建议「${row['自动建议']}」留作对照，原始观测值保持不变`,
  }
}

/** 复测：对判定为复测的项目登记复测值，复测值另存、原始观测值不覆盖，并按同一基线重算等级。 */
export function registerRemeasure(
  id: number,
  version: number,
  values: Record<ConsultItemKey, string>,
  operator: string,
): ActionResult {
  const rows = listRows(CONSULT_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的会诊单` }
  }
  const row = rows[index]
  if (row.status !== '会诊') {
    return {
      ok: false,
      message: `会诊单当前状态「${row.status}」，必须依次经过${CONSULT_FLOW.join('→')}，只有会诊阶段能登记复测`,
    }
  }
  const conflict = checkVersion(row, version, '会诊单')
  if (conflict) {
    return conflict
  }
  const pendingItems = ITEM_KEYS.filter((key) => row[`结论_${key}`] === '复测')
  const updated: EntryRow = { ...row, status: '复测', 版本: version + 1, 复测人: operator, 复测日期: today() }
  for (const key of pendingItems) {
    const raw = (values[key] ?? '').trim()
    const value = Number(raw)
    if (raw === '' || !Number.isFinite(value) || value < 0) {
      return { ok: false, message: `「${key}」已判定复测，必须登记不小于 0 的复测值` }
    }
    const { band } = resolveBand(key, String(row['隐患点编号']), String(row['观测日期']), listRows('threshold'))
    updated[`复测值_${key}`] = value
    updated[`复测等级_${key}`] = gradeOf(value, band)
  }
  try {
    withTransaction(() => {
      const next = [...rows]
      next[index] = updated
      saveRows(CONSULT_KEY, next)
      if (pendingItems.length > 0) {
        updateDeformationStatus(String(row['记录编号']), '待校核')
      }
    })
  } catch {
    return { ok: false, message: '复测结果写入失败，已整体回退，请重试' }
  }
  return {
    ok: true,
    message:
      pendingItems.length > 0
        ? '复测结果已登记并另存为新版本，原始观测值保持不变'
        : '全部采纳自动建议，无复测项，已确认通过复测环节',
  }
}

/** 校核：定最终等级（复测项以复测实测为准），达警示级及以上时同事务生成裂缝加测单。 */
export function completeConsultVerification(id: number, version: number, operator: string): ActionResult {
  const rows = listRows(CONSULT_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的会诊单` }
  }
  const row = rows[index]
  if (row.status !== '复测') {
    return {
      ok: false,
      message: `会诊单当前状态「${row.status}」，必须依次经过${CONSULT_FLOW.join('→')}，只有复测阶段能完成校核`,
    }
  }
  const conflict = checkVersion(row, version, '会诊单')
  if (conflict) {
    return conflict
  }
  const finalGrade = maxGrade(
    ITEM_KEYS.map((key) => String(row[`复测等级_${key}`] || row[`${key}等级`]) as GradeLevel),
  )
  const needExtra = finalGrade === '警示级' || finalGrade === '警戒级'
  const verifyDate = today()
  const updated: EntryRow = {
    ...row,
    status: '校核',
    pending: false,
    abnormal: needExtra,
    版本: version + 1,
    最终等级: finalGrade,
    校核人: operator,
    校核日期: verifyDate,
  }
  let extraCode = ''
  try {
    withTransaction(() => {
      const extraRows = listRows(CRACK_EXTRA_KEY)
      const duplicated = extraRows.some((extra) => String(extra['来源会诊编号']) === String(row['会诊编号']))
      if (needExtra && !duplicated) {
        extraCode = nextCode(extraRows, 'CEXT')
        const crackPoint = listRows('crack').find(
          (point) => String(point['隐患点编号']) === String(row['隐患点编号']),
        )
        const extraRow: EntryRow = {
          id: nextId(extraRows),
          status: '待判定',
          pending: true,
          abnormal: true,
          加测编号: extraCode,
          来源会诊编号: String(row['会诊编号']),
          隐患点编号: String(row['隐患点编号']),
          测点编号: crackPoint ? String(crackPoint['测点编号']) : '待指定',
          加测原因: `形变会诊 ${row['会诊编号']} 最终等级「${finalGrade}」`,
          要求完成日期: addDays(verifyDate, 3),
          监测人: '',
          处理备注: '',
          加测结果: '',
          版本: 1,
        }
        saveRows(CRACK_EXTRA_KEY, [...extraRows, extraRow])
        updated['加测编号'] = extraCode
      }
      const next = [...rows]
      next[index] = updated
      saveRows(CONSULT_KEY, next)
      updateDeformationStatus(String(row['记录编号']), '已校核')
    })
  } catch {
    return { ok: false, message: '校核写入失败，会诊单与裂缝加测单已整体回退，请重试' }
  }
  const extraMessage = extraCode ? `，已同步生成裂缝加测单 ${extraCode}（待判定）` : ''
  return { ok: true, message: `校核完成，最终等级「${finalGrade}」${extraMessage}` }
}

/** 旧记录补算：没有会诊单的形变记录，按观测日期当时有效的阈值配置或基线版本补建会诊单。 */
export function backfillConsultations(): ActionResult {
  const deformationRows = listRows('deformation')
  const consultRows = listRows(CONSULT_KEY)
  const thresholdRows = listRows('threshold')
  const existing = new Set(consultRows.map((row) => String(row['记录编号'])))
  const created: string[] = []
  const skipped: string[] = []
  try {
    withTransaction(() => {
      const working = [...consultRows]
      for (const record of deformationRows) {
        const recordCode = String(record['记录编号'])
        if (existing.has(recordCode)) {
          continue
        }
        const horizontal = Number(record['水平位移量'])
        const vertical = Number(record['垂直位移量'])
        const width = Number(record['裂缝宽度'])
        const rate = Number(record['变化速率'])
        if (![horizontal, vertical, width, rate].every((value) => Number.isFinite(value) && value >= 0)) {
          skipped.push(recordCode)
          continue
        }
        const values: Record<ConsultItemKey, number> = {
          位移: composeDisplacement(horizontal, vertical),
          裂缝宽度: width,
          速率: rate,
        }
        const observeDate = String(record['观测日期'])
        const graded = gradeConsultation(values, String(record['隐患点编号']), observeDate, thresholdRows)
        const consultRow: EntryRow = {
          ...blankConsultRow(nextId(working), nextCode(working, 'CONS')),
          abnormal: graded.suggestion !== '正常',
          记录编号: recordCode,
          隐患点编号: String(record['隐患点编号']),
          观测日期: observeDate,
          观测人: String(record['观测人'] ?? ''),
          位移值: values.位移,
          裂缝宽度值: values.裂缝宽度,
          速率值: values.速率,
          位移等级: graded.grades.位移,
          裂缝宽度等级: graded.grades.裂缝宽度,
          速率等级: graded.grades.速率,
          自动建议: graded.suggestion,
          基线来源: graded.source,
          来源: '基线补算',
        }
        working.push(consultRow)
        created.push(recordCode)
      }
      if (created.length > 0) {
        saveRows(CONSULT_KEY, working)
      }
    })
  } catch {
    return { ok: false, message: '旧记录补算写入失败，已整体回退，请重试' }
  }
  const skippedMessage = skipped.length > 0 ? `，跳过 ${skipped.length} 条数值无法解析的记录（${skipped.join('、')}）` : ''
  return {
    ok: true,
    message: `补算完成：为 ${created.length} 条旧记录补建会诊单（按当时有效的阈值配置或基线版本）${skippedMessage}`,
  }
}

/** 裂缝加测单逐级推进：待判定→会诊→复测→校核，越过阶段即拒绝。 */
export function advanceCrackExtra(
  id: number,
  version: number,
  payload: { 监测人?: string; 加测结果?: string; 处理备注?: string },
): ActionResult {
  const rows = listRows(CRACK_EXTRA_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的加测单` }
  }
  const row = rows[index]
  const flowIndex = CONSULT_FLOW.indexOf(String(row.status))
  if (flowIndex < 0 || flowIndex === CONSULT_FLOW.length - 1) {
    return { ok: false, message: `加测单已至终态「${row.status}」，不能再流转` }
  }
  const conflict = checkVersion(row, version, '加测单')
  if (conflict) {
    return conflict
  }
  const target = CONSULT_FLOW[flowIndex + 1]
  const updated: EntryRow = { ...row, status: target, 版本: version + 1, pending: target !== '校核' }
  if (target === '会诊') {
    const monitor = (payload.监测人 ?? '').trim()
    if (!monitor) {
      return { ok: false, message: '进入会诊前必须指定监测人' }
    }
    updated['监测人'] = monitor
    updated['处理备注'] = (payload.处理备注 ?? '').trim()
  }
  if (target === '复测') {
    const result = (payload.加测结果 ?? '').trim()
    if (!result) {
      return { ok: false, message: '进入复测前必须登记加测结果' }
    }
    updated['加测结果'] = result
    if ((payload.处理备注 ?? '').trim()) {
      updated['处理备注'] = (payload.处理备注 ?? '').trim()
    }
  }
  try {
    withTransaction(() => {
      const next = [...rows]
      next[index] = updated
      saveRows(CRACK_EXTRA_KEY, next)
    })
  } catch {
    return { ok: false, message: '加测单写入失败，已整体回退，请重试' }
  }
  return { ok: true, message: `加测单 ${row['加测编号']} 已进入「${target}」阶段` }
}
