/**
 * 阈值会诊队列的领域规则测试（纯 node，不依赖浏览器：
 * local-store 在没有 window 时退化为内存缓存）。
 * 运行：npm test
 */
import assert from 'node:assert/strict'

import {
  advanceExtra,
  advanceToRemeasure,
  baselineAt,
  createConsultationForRecord,
  submitDecisions,
  submitObservation,
  submitRemeasure,
  type ItemDecision,
  type JudgeItem,
} from '@/api/consultation-service'
import { runAction } from '@/api/local-service'
import { listRows, resetRows, saveRows, transact } from '@/data/local-store'

let passed = 0
function test(name: string, fn: () => void) {
  try {
    fn()
    passed += 1
    console.log(`PASS ${name}`)
  } catch (error) {
    console.error(`FAIL ${name}`)
    console.error(error)
    process.exit(1)
  }
}

function resetAll() {
  for (const key of ['deformation', 'crack', 'threshold', 'consultation', 'crack_extra']) {
    resetRows(key)
  }
}

function decisionsOf(结论: '采纳' | '复测', 理由 = '现场复核无误'): Record<JudgeItem, ItemDecision> {
  return {
    位移: { 结论, 理由 },
    裂缝宽度: { 结论, 理由 },
    速率: { 结论, 理由 },
  }
}

// ── 基线补算 ──
test('旧记录按观测日期取当时有效基线补算', () => {
  resetAll()
  const old = baselineAt('2025-08-10')
  assert.ok(old)
  assert.equal(old.生效日期, '2025-01-01')
  assert.deepEqual(old.triples['位移'], { 注意: 10, 警示: 20, 警戒: 30 })
  const current = baselineAt('2026-09-02')
  assert.ok(current)
  assert.equal(current.生效日期, '2026-01-01')
  assert.deepEqual(current.triples['位移'], { 注意: 8, 警示: 16, 警戒: 24 })
})

test('观测日期早于所有基线时退用最早一版', () => {
  resetAll()
  const baseline = baselineAt('2024-06-01')
  assert.ok(baseline)
  assert.equal(baseline.生效日期, '2025-01-01')
})

// ── 观测提交：分级建议 + 同步加测待办 ──
test('观测提交生成会诊单与自动分级，裂缝/速率越限同步生成加测待办', () => {
  resetAll()
  const result = submitObservation(
    { 隐患点编号: 'HAZA-0001', 观测日期: '2026-10-01', 水平位移量: 18.5, 垂直位移量: 6.1, 裂缝宽度: 22, 变化速率: 4.4, 观测人: '测试员' },
    '测试员',
  )
  assert.equal(result.ok, true, result.message)
  assert.equal(listRows('deformation').length, 4)
  const tickets = listRows('consultation')
  assert.equal(tickets.length, 1)
  const ticket = tickets[0]
  assert.equal(ticket.status, '待判定')
  assert.equal(ticket.version, 1)
  assert.equal(ticket['位移建议'], '警示级') // max(18.5, 6.1) → 16≤18.5<24
  assert.equal(ticket['裂缝建议'], '警戒级') // 22 ≥ 20
  assert.equal(ticket['速率建议'], '警示级') // 3≤4.4<6
  assert.equal(ticket['自动综合建议'], '警戒级')
  const todos = listRows('crack_extra')
  assert.equal(todos.length, 1)
  assert.equal(todos[0].status, '待判定')
  assert.equal(todos[0]['触发级别'], '警戒级')
  assert.equal(todos[0]['会诊单号'], ticket['会诊单号'])
})

test('全部正常的观测不生成加测待办', () => {
  resetAll()
  const result = submitObservation(
    { 隐患点编号: 'HAZA-0002', 观测日期: '2026-10-01', 水平位移量: 1, 垂直位移量: 1, 裂缝宽度: 1, 变化速率: 0.5, 观测人: '测试员' },
    '测试员',
  )
  assert.equal(result.ok, true, result.message)
  assert.equal(listRows('consultation').length, 1)
  assert.equal(listRows('crack_extra').length, 0)
})

test('非法输入直接拒绝且不写入', () => {
  resetAll()
  const result = submitObservation(
    { 隐患点编号: '', 观测日期: '2026-10-01', 水平位移量: -1, 垂直位移量: 0, 裂缝宽度: 0, 变化速率: 0, 观测人: '' },
    '测试员',
  )
  assert.equal(result.ok, false)
  assert.equal(listRows('consultation').length, 0)
  assert.equal(listRows('deformation').length, 3)
})

// ── 并发提交仅保留首个版本 ──
test('同一记录重复发起会诊仅保留首个版本', () => {
  resetAll()
  const first = createConsultationForRecord(1, '测试员')
  assert.equal(first.ok, true, first.message)
  const second = createConsultationForRecord(1, '另一个人')
  assert.equal(second.ok, false)
  assert.match(second.message, /首个版本/)
  assert.equal(listRows('consultation').length, 1)
})

test('旧记录补算使用当时有效基线', () => {
  resetAll()
  createConsultationForRecord(1, '测试员')
  const ticket = listRows('consultation')[0]
  assert.equal(ticket['基线生效日期'], '2025-01-01')
  assert.equal(ticket['位移建议'], '正常') // 9.0 < 旧基线注意级 10
  assert.equal(ticket['裂缝建议'], '注意级') // 12.5 ∈ [5, 15)
  assert.equal(ticket['速率建议'], '注意级') // 2.6 ∈ [2, 4)
})

test('版本号不匹配的旧提交被拒绝', () => {
  resetAll()
  createConsultationForRecord(1, '测试员')
  const ticket = listRows('consultation')[0]
  const stale = submitDecisions(Number(ticket.id), decisionsOf('采纳'), 99, '测试员')
  assert.equal(stale.ok, false)
  assert.match(stale.message, /首个版本/)
  assert.equal(listRows('consultation')[0].status, '待判定')
})

// ── 状态机：待判定→会诊→复测→校核，越级即拒绝 ──
test('越过阶段的推进被拒绝', () => {
  resetAll()
  createConsultationForRecord(1, '测试员')
  const ticket = listRows('consultation')[0]
  const skipToRemeasure = advanceToRemeasure(Number(ticket.id), 1, '测试员')
  assert.equal(skipToRemeasure.ok, false)
  assert.match(skipToRemeasure.message, /越过阶段/)
  const skipRemeasureSubmit = submitRemeasure(Number(ticket.id), {}, '', 1, '测试员')
  assert.equal(skipRemeasureSubmit.ok, false)
  assert.match(skipRemeasureSubmit.message, /越过阶段/)
  assert.equal(listRows('consultation')[0].status, '待判定')
})

test('逐项判定必须写理由，缺理由拒绝', () => {
  resetAll()
  createConsultationForRecord(1, '测试员')
  const ticket = listRows('consultation')[0]
  const noReason = submitDecisions(
    Number(ticket.id),
    { 位移: { 结论: '采纳', 理由: '' }, 裂缝宽度: { 结论: '采纳', 理由: 'ok' }, 速率: { 结论: '复测', 理由: '  ' } },
    1,
    '测试员',
  )
  assert.equal(noReason.ok, false)
  assert.match(noReason.message, /理由/)
  assert.equal(listRows('consultation')[0].status, '待判定')
})

test('全流程依次推进，复测值不覆盖原始值，人工优先并打冲突标记', () => {
  resetAll()
  submitObservation(
    { 隐患点编号: 'HAZA-0001', 观测日期: '2026-10-01', 水平位移量: 18.5, 垂直位移量: 6.1, 裂缝宽度: 22, 变化速率: 4.4, 观测人: '测试员' },
    '测试员',
  )
  const id = Number(listRows('consultation')[0].id)

  const decided = submitDecisions(
    id,
    {
      位移: { 结论: '采纳', 理由: '位移测值稳定' },
      裂缝宽度: { 结论: '复测', 理由: '疑似读数偏大，需复测' },
      速率: { 结论: '采纳', 理由: '速率与历史一致' },
    },
    1,
    '测试员',
  )
  assert.equal(decided.ok, true, decided.message)
  assert.equal(listRows('consultation')[0].status, '会诊')

  // 复测项未录值不得进入校核
  const advanced = advanceToRemeasure(id, 2, '测试员')
  assert.equal(advanced.ok, true, advanced.message)
  const missingValue = submitRemeasure(id, {}, '', 3, '测试员')
  assert.equal(missingValue.ok, false)
  assert.match(missingValue.message, /复测值/)

  // 人工复测值低于自动建议：人工优先，最终分级降级并打冲突标记
  const remeasured = submitRemeasure(id, { 裂缝宽度: 8 }, '复测后裂缝宽度回落', 3, '测试员')
  assert.equal(remeasured.ok, true, remeasured.message)
  const ticket = listRows('consultation')[0]
  assert.equal(ticket.status, '校核')
  assert.equal(ticket.pending, false)
  assert.equal(ticket.version, 4)
  assert.equal(ticket['最终分级'], '警示级') // max(警示, 注意, 警示)
  assert.equal(ticket['自动综合建议'], '警戒级')
  assert.equal(ticket.abnormal, true) // 与自动建议不一致 → 冲突标记
  assert.equal(ticket['原始裂缝宽度'], 22) // 原始值不被覆盖
  assert.equal(ticket['裂缝复测值'], 8)
})

test('全部采纳时仍须依次经过复测阶段', () => {
  resetAll()
  createConsultationForRecord(3, '测试员') // DEFO-0003 全部正常
  const id = Number(listRows('consultation')[0].id)
  assert.equal(submitDecisions(id, decisionsOf('采纳'), 1, '测试员').ok, true)
  assert.equal(advanceToRemeasure(id, 2, '测试员').ok, true)
  const done = submitRemeasure(id, {}, '', 3, '测试员')
  assert.equal(done.ok, true, done.message)
  const ticket = listRows('consultation')[0]
  assert.equal(ticket.status, '校核')
  assert.equal(ticket['最终分级'], '正常')
  assert.equal(ticket.abnormal, false)
})

// ── 裂缝加测待办：同一套状态机 ──
test('加测待办越级推进与旧版本推进均被拒绝，逐阶推进到校核', () => {
  resetAll()
  submitObservation(
    { 隐患点编号: 'HAZA-0001', 观测日期: '2026-10-01', 水平位移量: 1, 垂直位移量: 1, 裂缝宽度: 22, 变化速率: 4.4, 观测人: '测试员' },
    '测试员',
  )
  const todo = listRows('crack_extra')[0]
  const id = Number(todo.id)

  const skip = advanceExtra(id, '复测', 1, '测试员', '')
  assert.equal(skip.ok, false)
  assert.match(skip.message, /越级/)

  const stale = advanceExtra(id, '会诊', 99, '测试员', '')
  assert.equal(stale.ok, false)
  assert.match(stale.message, /首个版本/)

  assert.equal(advanceExtra(id, '会诊', 1, '测试员', '已纳入会诊').ok, true)
  assert.equal(advanceExtra(id, '复测', 2, '测试员', '现场加测完成').ok, true)
  assert.equal(advanceExtra(id, '校核', 3, '测试员', '结果已校核').ok, true)
  const final = listRows('crack_extra')[0]
  assert.equal(final.status, '校核')
  assert.equal(final.pending, false)
  assert.equal(final.version, 4)

  const again = advanceExtra(id, '校核', 4, '测试员', '')
  assert.equal(again.ok, false)
})

// ── 写入失败整体回退 ──
test('事务内任一步失败则整体回退', () => {
  resetAll()
  createConsultationForRecord(1, '测试员')
  const before = listRows('consultation').length
  assert.throws(() =>
    transact(() => {
      saveRows('consultation', [])
      saveRows('crack_extra', [])
      throw new Error('模拟写入失败')
    }),
  )
  assert.equal(listRows('consultation').length, before)
  assert.equal(listRows('crack_extra').length, 1) // 同步生成的加测待办也还在
})

// ── 形变记录校核与会诊流程联动 ──
test('会诊单未走完流程时形变记录不得确认校核', () => {
  resetAll()
  createConsultationForRecord(2, '测试员') // DEFO-0002 待校核
  const blocked = runAction('deformation', 2, '确认校核')
  assert.equal(blocked.ok, false)
  assert.match(blocked.message, /会诊/)

  const ticket = listRows('consultation')[0]
  const id = Number(ticket.id)
  assert.equal(submitDecisions(id, decisionsOf('采纳'), 1, '测试员').ok, true)
  assert.equal(advanceToRemeasure(id, 2, '测试员').ok, true)
  assert.equal(submitRemeasure(id, {}, '', 3, '测试员').ok, true)

  const allowed = runAction('deformation', 2, '确认校核')
  assert.equal(allowed.ok, true, allowed.message)
})

console.log(`\n${passed} 个用例全部通过`)
