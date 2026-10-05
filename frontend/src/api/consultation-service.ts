import { listRows, saveRows, transact } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

/**
 * 形变观测阈值会诊队列的领域服务。页面一律从这里进出，不直接写存储。
 *
 * 调用关系：
 *   形变观测页 submitObservation（新观测提交）/ createConsultationForRecord（旧记录补会诊）
 *     → 建会诊单（待判定，自动分级建议，原始值快照，阈值基线快照）
 *     → 裂缝宽度或速率达注意级及以上时，同一事务同步生成裂缝加测待办
 *   阈值会诊页 submitDecisions / advanceToRemeasure / submitRemeasure
 *     → 会诊单按 待判定→会诊→复测→校核 逐阶推进
 *   裂缝监测页 advanceExtra → 加测单走同一套状态机
 *   形变记录「确认校核」（local-service.runAction）→ assertDeformationVerifyAllowed 守卫
 *
 * 约定：
 * - 自动建议与人工判定冲突时人工优先：逐项判定（采纳/复测）+理由必填，
 *   最终分级以人工判定路径为准；自动建议留痕，最终分级与自动综合建议
 *   不一致的会诊单打冲突标记（abnormal），看板可见。
 * - 原始观测值写入快照后任何阶段不改写，复测值另存字段，不覆盖原始值。
 * - 旧记录没有阈值快照：建单时按观测日期取当时有效基线补算分级。
 * - 每次变更携带期望版本号，并发提交仅保留首个版本，其余拒绝。
 * - 多表写入包在 transact 里，任一步失败整体回退。
 */

// ── 状态机：待判定→会诊→复测→校核，只能逐阶推进，越过阶段即拒绝 ──
export const CONSULT_STAGES = ['待判定', '会诊', '复测', '校核'] as const
export type ConsultStage = (typeof CONSULT_STAGES)[number]
const TERMINAL_STAGE: ConsultStage = '校核'

export function nextStage(current: string): ConsultStage | null {
  const index = CONSULT_STAGES.indexOf(current as ConsultStage)
  if (index < 0 || index >= CONSULT_STAGES.length - 1) {
    return null
  }
  return CONSULT_STAGES[index + 1]
}

// ── 分级：正常 < 注意级 < 警示级 < 警戒级 ──
export const GRADE_ORDER = ['正常', '注意级', '警示级', '警戒级'] as const
export type Grade = (typeof GRADE_ORDER)[number]

export type JudgeItem = '位移' | '裂缝宽度' | '速率'
export const JUDGE_ITEMS: JudgeItem[] = ['位移', '裂缝宽度', '速率']

export type ThresholdTriple = { 注意: number; 警示: number; 警戒: number }

export type Baseline = {
  基线编号: string
  生效日期: string
  triples: Record<JudgeItem, ThresholdTriple>
}

export type ItemDecision = { 结论: '采纳' | '复测'; 理由: string }

export type ObservationInput = {
  隐患点编号: string
  观测日期: string
  水平位移量: number
  垂直位移量: number
  裂缝宽度: number
  变化速率: number
  观测人: string
}

// 每个判定项在会诊单行上的字段位：建议/判定/理由/复测值/阈值快照、展示单位。
const ITEM_FIELDS: Record<
  JudgeItem,
  { suggest: string; decision: string; reason: string; remeasure: string; triple: [string, string, string]; unit: string }
> = {
  位移: { suggest: '位移建议', decision: '位移判定', reason: '位移理由', remeasure: '位移复测值', triple: ['位移阈值注意', '位移阈值警示', '位移阈值警戒'], unit: 'mm' },
  裂缝宽度: { suggest: '裂缝建议', decision: '裂缝判定', reason: '裂缝理由', remeasure: '裂缝复测值', triple: ['裂缝阈值注意', '裂缝阈值警示', '裂缝阈值警戒'], unit: 'mm' },
  速率: { suggest: '速率建议', decision: '速率判定', reason: '速率理由', remeasure: '速率复测值', triple: ['速率阈值注意', '速率阈值警示', '速率阈值警戒'], unit: 'mm/d' },
}

function gradeOf(value: number, triple: ThresholdTriple): Grade {
  if (value >= triple.警戒) return '警戒级'
  if (value >= triple.警示) return '警示级'
  if (value >= triple.注意) return '注意级'
  return '正常'
}

function maxGrade(grades: Grade[]): Grade {
  return grades.reduce<Grade>(
    (top, grade) => (GRADE_ORDER.indexOf(grade) > GRADE_ORDER.indexOf(top) ? grade : top),
    '正常',
  )
}

function fail(message: string): ActionResult {
  return { ok: false, message }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ── 阈值基线：旧记录无阈值快照时，按观测日期取当时有效基线补算 ──
const EFFECTIVE_STATUSES = new Set(['已生效', '已调整'])

export function baselineAt(date: string): Baseline | null {
  const rows = listRows('threshold').filter((row) => EFFECTIVE_STATUSES.has(String(row.status)))
  const triples = {} as Record<JudgeItem, ThresholdTriple>
  const codes: string[] = []
  let latest = ''
  for (const item of JUDGE_ITEMS) {
    const candidates = rows
      .filter((row) => String(row['监测类型']) === item && String(row['生效日期'] ?? '') !== '')
      .sort((a, b) => String(a['生效日期']).localeCompare(String(b['生效日期'])))
    if (candidates.length === 0) {
      return null
    }
    const notLater = candidates.filter((row) => String(row['生效日期']) <= date)
    // 观测日期早于所有基线时退用最早一版，保证旧记录也能补算。
    const picked = notLater.length > 0 ? notLater[notLater.length - 1] : candidates[0]
    triples[item] = {
      注意: Number(picked['注意级阈值']),
      警示: Number(picked['警示级阈值']),
      警戒: Number(picked['警戒级阈值']),
    }
    codes.push(String(picked['阈值编号']))
    const effective = String(picked['生效日期'])
    if (effective > latest) {
      latest = effective
    }
  }
  return { 基线编号: codes.join('+'), 生效日期: latest, triples }
}

// ── 内部工具 ──
function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function formatCode(prefix: string, id: number): string {
  return `${prefix}-${String(id).padStart(4, '0')}`
}

function observedValue(record: EntryRow, item: JudgeItem): number {
  if (item === '位移') {
    return Math.max(Math.abs(Number(record['水平位移量']) || 0), Math.abs(Number(record['垂直位移量']) || 0))
  }
  if (item === '裂缝宽度') {
    return Math.abs(Number(record['裂缝宽度']) || 0)
  }
  return Math.abs(Number(record['变化速率']) || 0)
}

function buildTicket(
  record: EntryRow,
  baseline: Baseline,
  operator: string,
  now: string,
): { ticket: EntryRow; suggestions: Record<JudgeItem, Grade> } {
  const id = nextId(listRows('consultation'))
  const suggestions = {} as Record<JudgeItem, Grade>
  for (const item of JUDGE_ITEMS) {
    suggestions[item] = gradeOf(observedValue(record, item), baseline.triples[item])
  }
  const ticket: EntryRow = {
    id,
    status: '待判定',
    pending: true,
    abnormal: false,
    version: 1,
    会诊单号: formatCode('CONS', id),
    记录编号: String(record['记录编号']),
    隐患点编号: String(record['隐患点编号']),
    观测日期: String(record['观测日期']),
    观测人: String(record['观测人']),
    // 原始值快照：之后任何阶段只读，复测值另存，不覆盖原始值。
    原始水平位移: Number(record['水平位移量']) || 0,
    原始垂直位移: Number(record['垂直位移量']) || 0,
    原始裂缝宽度: Number(record['裂缝宽度']) || 0,
    原始速率: Number(record['变化速率']) || 0,
    位移取值: observedValue(record, '位移'),
    基线编号: baseline.基线编号,
    基线生效日期: baseline.生效日期,
    基线来源: '按观测日期取当时有效基线补算',
    自动综合建议: maxGrade(JUDGE_ITEMS.map((item) => suggestions[item])),
    位移判定: '',
    裂缝判定: '',
    速率判定: '',
    位移理由: '',
    裂缝理由: '',
    速率理由: '',
    位移复测值: '',
    裂缝复测值: '',
    速率复测值: '',
    复测说明: '',
    最终分级: '待定',
    处理人: operator,
    更新时间: now,
  }
  for (const item of JUDGE_ITEMS) {
    const fields = ITEM_FIELDS[item]
    ticket[fields.suggest] = suggestions[item]
    ticket[fields.triple[0]] = baseline.triples[item].注意
    ticket[fields.triple[1]] = baseline.triples[item].警示
    ticket[fields.triple[2]] = baseline.triples[item].警戒
  }
  return { ticket, suggestions }
}

// 裂缝宽度或速率达注意级及以上 → 同步生成裂缝监测加测待办。
function buildExtraTodo(
  ticket: EntryRow,
  suggestions: Record<JudgeItem, Grade>,
  operator: string,
  now: string,
): EntryRow | null {
  const triggered = (['裂缝宽度', '速率'] as JudgeItem[]).filter((item) => suggestions[item] !== '正常')
  if (triggered.length === 0) {
    return null
  }
  const id = nextId(listRows('crack_extra'))
  const reasons = triggered.map((item) => {
    const value = item === '裂缝宽度' ? ticket['原始裂缝宽度'] : ticket['原始速率']
    return `${item} ${value}${ITEM_FIELDS[item].unit} 达${suggestions[item]}`
  })
  const triggerGrade = maxGrade(triggered.map((item) => suggestions[item]))
  return {
    id,
    status: '待判定',
    pending: true,
    abnormal: GRADE_ORDER.indexOf(triggerGrade) >= GRADE_ORDER.indexOf('警示级'),
    version: 1,
    加测单号: formatCode('CRAX', id),
    会诊单号: String(ticket['会诊单号']),
    记录编号: String(ticket['记录编号']),
    隐患点编号: String(ticket['隐患点编号']),
    加测原因: reasons.join('；'),
    触发级别: triggerGrade,
    处理人: operator,
    处理备注: '',
    更新时间: now,
  }
}

function mustGetTicket(ticketId: number): EntryRow {
  const ticket = listRows('consultation').find((row) => Number(row.id) === ticketId)
  if (!ticket) {
    throw new Error(`没有找到编号为 ${ticketId} 的会诊单`)
  }
  return ticket
}

function assertStage(row: EntryRow, expected: ConsultStage, label: string): void {
  const current = String(row.status)
  if (current !== expected) {
    throw new Error(
      `${label}当前阶段为「${current}」，必须依次经过${CONSULT_STAGES.join('→')}，越过阶段即拒绝`,
    )
  }
}

function assertVersion(row: EntryRow, expectedVersion: number): void {
  if (Number(row.version) !== expectedVersion) {
    throw new Error(`已有更新的提交版本（当前 v${row.version}），并发提交仅保留首个版本，本次未写入`)
  }
}

function replaceRow(key: string, updated: EntryRow): void {
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === Number(updated.id))
  if (index < 0) {
    throw new Error('数据已被其他人移除，请刷新后重试')
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
}

// ── 观测提交：形变记录 + 会诊单 (+ 加测待办) 同事务写入 ──
export function submitObservation(input: ObservationInput, operator: string): ActionResult {
  if (!input.隐患点编号.trim()) return fail('隐患点编号不能为空')
  if (!input.观测日期.trim()) return fail('观测日期不能为空')
  if (!input.观测人.trim()) return fail('观测人不能为空')
  const numerics: [string, number][] = [
    ['水平位移量', input.水平位移量],
    ['垂直位移量', input.垂直位移量],
    ['裂缝宽度', input.裂缝宽度],
    ['变化速率', input.变化速率],
  ]
  for (const [label, value] of numerics) {
    if (!Number.isFinite(value) || value < 0) {
      return fail(`${label}必须是不小于 0 的数字`)
    }
  }
  try {
    const result = transact(() => {
      const baseline = baselineAt(input.观测日期.trim())
      if (!baseline) {
        throw new Error('未找到有效的阈值基线，请先在预警阈值模块发布配置')
      }
      const defoRows = listRows('deformation')
      const recordId = nextId(defoRows)
      const record: EntryRow = {
        id: recordId,
        status: '已观测',
        pending: true,
        abnormal: false,
        记录编号: formatCode('DEFO', recordId),
        隐患点编号: input.隐患点编号.trim(),
        观测日期: input.观测日期.trim(),
        裂缝宽度: input.裂缝宽度,
        水平位移量: input.水平位移量,
        垂直位移量: input.垂直位移量,
        变化速率: input.变化速率,
        观测人: input.观测人.trim(),
        记录状态: '已观测',
      }
      const now = new Date().toISOString()
      const { ticket, suggestions } = buildTicket(record, baseline, operator, now)
      const todo = buildExtraTodo(ticket, suggestions, operator, now)
      saveRows('deformation', [...defoRows, record])
      saveRows('consultation', [...listRows('consultation'), ticket])
      if (todo) {
        saveRows('crack_extra', [...listRows('crack_extra'), todo])
      }
      return { ticket, todo }
    })
    const extra = result.todo ? `，同步生成裂缝加测待办 ${result.todo['加测单号']}` : ''
    return { ok: true, message: `观测已提交，生成会诊单 ${result.ticket['会诊单号']}（待判定）${extra}` }
  } catch (error) {
    return fail(`提交失败：${errorText(error)}，本次未写入任何数据`)
  }
}

// ── 旧记录补会诊：同一记录只保留首个会诊单，重复提交拒绝 ──
export function createConsultationForRecord(recordId: number, operator: string): ActionResult {
  try {
    const result = transact(() => {
      const record = listRows('deformation').find((row) => Number(row.id) === recordId)
      if (!record) {
        throw new Error(`没有找到编号为 ${recordId} 的形变记录`)
      }
      const recordCode = String(record['记录编号'])
      const existing = listRows('consultation').find((row) => String(row['记录编号']) === recordCode)
      if (existing) {
        throw new Error(`记录 ${recordCode} 已存在会诊单 ${existing['会诊单号']}，并发提交仅保留首个版本`)
      }
      const baseline = baselineAt(String(record['观测日期']))
      if (!baseline) {
        throw new Error('未找到有效的阈值基线，请先在预警阈值模块发布配置')
      }
      const now = new Date().toISOString()
      const { ticket, suggestions } = buildTicket(record, baseline, operator, now)
      const todo = buildExtraTodo(ticket, suggestions, operator, now)
      saveRows('consultation', [...listRows('consultation'), ticket])
      if (todo) {
        saveRows('crack_extra', [...listRows('crack_extra'), todo])
      }
      return { ticket, todo }
    })
    const extra = result.todo ? `，同步生成裂缝加测待办 ${result.todo['加测单号']}` : ''
    return {
      ok: true,
      message: `已按 ${result.ticket['基线生效日期']} 起生效的基线补算分级，生成会诊单 ${result.ticket['会诊单号']}（待判定）${extra}`,
    }
  } catch (error) {
    return fail(`发起会诊失败：${errorText(error)}，本次未写入任何数据`)
  }
}

// ── 待判定 → 会诊：观测人逐项判定采纳/复测，理由必填 ──
export function submitDecisions(
  ticketId: number,
  decisions: Record<JudgeItem, ItemDecision>,
  expectedVersion: number,
  operator: string,
): ActionResult {
  try {
    const result = transact(() => {
      const ticket = mustGetTicket(ticketId)
      assertStage(ticket, '待判定', '会诊单')
      assertVersion(ticket, expectedVersion)
      for (const item of JUDGE_ITEMS) {
        const decision = decisions[item]
        if (!decision || (decision.结论 !== '采纳' && decision.结论 !== '复测')) {
          throw new Error(`「${item}」必须逐项选择采纳或复测`)
        }
        if (!decision.理由 || decision.理由.trim() === '') {
          throw new Error(`「${item}」必须填写${decision.结论}理由，不能留空`)
        }
      }
      const updated: EntryRow = {
        ...ticket,
        status: '会诊',
        version: expectedVersion + 1,
        处理人: operator,
        更新时间: new Date().toISOString(),
      }
      for (const item of JUDGE_ITEMS) {
        const fields = ITEM_FIELDS[item]
        updated[fields.decision] = decisions[item].结论
        updated[fields.reason] = decisions[item].理由.trim()
      }
      const allAdopted = JUDGE_ITEMS.every((item) => decisions[item].结论 === '采纳')
      updated['最终分级'] = allAdopted ? String(ticket['自动综合建议']) : '待定（含复测项）'
      replaceRow('consultation', updated)
      return updated
    })
    return { ok: true, message: `会诊单 ${result['会诊单号']} 逐项判定已提交，进入「会诊」阶段（v${result.version}）` }
  } catch (error) {
    return fail(`提交判定失败：${errorText(error)}`)
  }
}

// ── 会诊 → 复测 ──
export function advanceToRemeasure(ticketId: number, expectedVersion: number, operator: string): ActionResult {
  try {
    const result = transact(() => {
      const ticket = mustGetTicket(ticketId)
      assertStage(ticket, '会诊', '会诊单')
      assertVersion(ticket, expectedVersion)
      const remeasureItems = JUDGE_ITEMS.filter(
        (item) => String(ticket[ITEM_FIELDS[item].decision]) === '复测',
      )
      const updated: EntryRow = {
        ...ticket,
        status: '复测',
        version: expectedVersion + 1,
        处理人: operator,
        更新时间: new Date().toISOString(),
      }
      if (remeasureItems.length === 0) {
        updated['复测说明'] = '全部采纳自动建议，无复测项'
      }
      replaceRow('consultation', updated)
      return { updated, remeasureItems }
    })
    const note = result.remeasureItems.length === 0 ? '（无复测项）' : `（待复测：${result.remeasureItems.join('、')}）`
    return { ok: true, message: `会诊单 ${result.updated['会诊单号']} 进入「复测」阶段${note}（v${result.updated.version}）` }
  } catch (error) {
    return fail(`进入复测失败：${errorText(error)}`)
  }
}

// ── 复测 → 校核：录入复测值（不覆盖原始值），按基线快照重算最终分级 ──
export function submitRemeasure(
  ticketId: number,
  values: Partial<Record<JudgeItem, number>>,
  note: string,
  expectedVersion: number,
  operator: string,
): ActionResult {
  try {
    const result = transact(() => {
      const ticket = mustGetTicket(ticketId)
      assertStage(ticket, '复测', '会诊单')
      assertVersion(ticket, expectedVersion)
      const updated: EntryRow = { ...ticket }
      const finalGrades: Grade[] = []
      for (const item of JUDGE_ITEMS) {
        const fields = ITEM_FIELDS[item]
        if (String(ticket[fields.decision]) === '复测') {
          const value = values[item]
          if (value === undefined || !Number.isFinite(value) || value < 0) {
            throw new Error(`「${item}」已判定复测，必须录入不小于 0 的复测值`)
          }
          updated[fields.remeasure] = value
          const triple: ThresholdTriple = {
            注意: Number(ticket[fields.triple[0]]),
            警示: Number(ticket[fields.triple[1]]),
            警戒: Number(ticket[fields.triple[2]]),
          }
          finalGrades.push(gradeOf(value, triple))
        } else {
          finalGrades.push(String(ticket[fields.suggest]) as Grade)
        }
      }
      const finalGrade = maxGrade(finalGrades)
      updated['最终分级'] = finalGrade
      if (note.trim() !== '') {
        updated['复测说明'] = note.trim()
      }
      // 人工优先：最终分级以观测人判定路径为准；与自动综合建议不一致即冲突标记。
      updated.abnormal = finalGrade !== String(ticket['自动综合建议'])
      updated.status = '校核'
      updated.pending = false
      updated.version = expectedVersion + 1
      updated['处理人'] = operator
      updated['更新时间'] = new Date().toISOString()
      replaceRow('consultation', updated)
      return updated
    })
    const conflict = result.abnormal ? '，与自动建议不一致，已打冲突标记' : ''
    return { ok: true, message: `会诊单 ${result['会诊单号']} 复测完成，最终分级「${result['最终分级']}」${conflict}，进入「校核」阶段（v${result.version}）` }
  } catch (error) {
    return fail(`提交复测失败：${errorText(error)}`)
  }
}

// ── 裂缝加测待办：同一套状态机，目标阶段必须恰好是下一阶段 ──
export function advanceExtra(
  todoId: number,
  target: string,
  expectedVersion: number,
  operator: string,
  note: string,
): ActionResult {
  try {
    const result = transact(() => {
      const todo = listRows('crack_extra').find((row) => Number(row.id) === todoId)
      if (!todo) {
        throw new Error(`没有找到编号为 ${todoId} 的加测单`)
      }
      const allowed = nextStage(String(todo.status))
      if (!allowed) {
        throw new Error(`加测单已到「${TERMINAL_STAGE}」阶段，流程已终结`)
      }
      if (target !== allowed) {
        throw new Error(
          `加测单当前阶段为「${todo.status}」，必须依次经过${CONSULT_STAGES.join('→')}，不能越级到「${target}」`,
        )
      }
      assertVersion(todo, expectedVersion)
      const updated: EntryRow = {
        ...todo,
        status: target,
        pending: target !== TERMINAL_STAGE,
        version: expectedVersion + 1,
        处理人: operator,
        处理备注: note.trim() !== '' ? note.trim() : String(todo['处理备注'] ?? ''),
        更新时间: new Date().toISOString(),
      }
      replaceRow('crack_extra', updated)
      return updated
    })
    return { ok: true, message: `加测单 ${result['加测单号']} 已推进至「${result.status}」（v${result.version}）` }
  } catch (error) {
    return fail(`加测单推进失败：${errorText(error)}`)
  }
}

// ── 形变记录「确认校核」守卫：关联会诊单未走完会诊流程则拒绝 ──
export function assertDeformationVerifyAllowed(recordCode: string): string | null {
  const ticket = listRows('consultation').find((row) => String(row['记录编号']) === recordCode)
  if (ticket && String(ticket.status) !== TERMINAL_STAGE) {
    return `记录 ${recordCode} 的会诊单 ${ticket['会诊单号']} 仍在「${ticket.status}」阶段，确认校核前必须依次完成会诊流程`
  }
  return null
}
