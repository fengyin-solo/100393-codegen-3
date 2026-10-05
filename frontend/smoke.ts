// 冒烟测试：直接驱动 local-service 的会诊链路，验证业务规则。
// 运行：node_modules/.bin/esbuild smoke.ts --bundle --platform=node --alias:@=./src --outfile=/tmp/smoke.mjs && node /tmp/smoke.mjs

// localStorage 可控桩：failWrites=true 时 setItem 抛错，用于验证整体回退。
let failWrites = false
const store = new Map<string, string>()
;(globalThis as Record<string, unknown>).window = {
  localStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (failWrites) throw new Error('quota exceeded')
      store.set(k, v)
    },
    removeItem: (k: string) => store.delete(k),
  },
}

const {
  submitObservation,
  submitConsultReview,
  registerRemeasure,
  completeConsultVerification,
  backfillConsultations,
  advanceCrackExtra,
  listEntries,
  runAction,
} = await import('./src/api/local-service')

let passed = 0
let failed = 0
function check(name: string, cond: boolean, extra = '') {
  if (cond) {
    passed++
    console.log(`  PASS ${name}`)
  } else {
    failed++
    console.log(`  FAIL ${name} ${extra}`)
  }
}

// ---------- 1. 旧记录补算：按当时有效基线/阈值配置 ----------
console.log('== 旧记录补算 ==')
const bf1 = backfillConsultations()
check('补算成功', bf1.ok, bf1.message)
const consults = listEntries('consultation').items
check('补建 3 张会诊单', consults.length === 3, `实际 ${consults.length}`)
const byRecord = (code: string) => consults.find((r) => r['记录编号'] === code)!
check('DEFO-0001 走 2025 基线→注意级', byRecord('DEFO-0001')['自动建议'] === '注意级' && String(byRecord('DEFO-0001')['基线来源']).includes('基线V2025'), String(byRecord('DEFO-0001')['基线来源']))
check('DEFO-0002 走阈值配置→警示级', byRecord('DEFO-0002')['自动建议'] === '警示级' && String(byRecord('DEFO-0002')['基线来源']).includes('THRE'), String(byRecord('DEFO-0002')['基线来源']))
check('DEFO-0003 全部正常', byRecord('DEFO-0003')['自动建议'] === '正常')
check('合成位移 37.3', byRecord('DEFO-0002')['位移值'] === 37.3, String(byRecord('DEFO-0002')['位移值']))
const bf2 = backfillConsultations()
check('重复补算幂等（0 新建）', bf2.ok && listEntries('consultation').items.length === 3, bf2.message)

// ---------- 2. 会诊：逐项理由必填 + 版本冲突 ----------
console.log('== 会诊（逐项理由/版本） ==')
const target = byRecord('DEFO-0002')
const id = Number(target.id)
const ver = Number(target['版本'])
const allAdopt = {
  位移: { 结论: '采纳', 理由: '现场复核位移曲线平稳' },
  裂缝宽度: { 结论: '采纳', 理由: '与人工丈量一致' },
  速率: { 结论: '采纳', 理由: '连续三日速率吻合' },
}
const missing = submitConsultReview(id, ver, { ...allAdopt, 速率: { 结论: '采纳', 理由: '' } }, '张明')
check('缺理由被拒绝', !missing.ok, missing.message)
const stale = submitConsultReview(id, ver + 9, allAdopt, '张明')
check('版本不符被拒绝（并发仅留首版）', !stale.ok && stale.message.includes('首个版本'), stale.message)
const reviewed = submitConsultReview(id, ver, allAdopt, '张明')
check('会诊提交成功', reviewed.ok, reviewed.message)
const again = submitConsultReview(id, ver + 1, allAdopt, '张明')
check('重复提交会诊被拒绝（顺序）', !again.ok, again.message)

// ---------- 3. 复测（无复测项直通）→ 校核 → 同步加测单 ----------
console.log('== 复测→校核→加测单 ==')
const rm0 = registerRemeasure(id, ver + 1, { 位移: '', 裂缝宽度: '', 速率: '' }, '张明')
check('无复测项直通复测', rm0.ok, rm0.message)
const vf = completeConsultVerification(id, ver + 2, '王强')
check('校核完成且生成加测单', vf.ok && vf.message.includes('CEXT-0001'), vf.message)
const extras = listEntries('crack_extra').items
check('加测单为待判定', extras.length === 1 && extras[0].status === '待判定' && extras[0]['来源会诊编号'] === 'CONS-0002')
const defo2 = listEntries('deformation').items.find((r) => r['记录编号'] === 'DEFO-0002')!
check('形变记录转已校核', defo2.status === '已校核' && defo2['记录状态'] === '已校核')
const consult2 = listEntries('consultation').items.find((r) => Number(r.id) === id)!
check('最终等级=警示级', consult2['最终等级'] === '警示级' && consult2['加测编号'] === 'CEXT-0001')
const vfAgain = completeConsultVerification(id, ver + 3, '王强')
check('终态后拒绝再校核', !vfAgain.ok, vfAgain.message)

// ---------- 4. 加测单严格顺序 ----------
console.log('== 加测单逐级流转 ==')
const extraId = Number(extras[0].id)
const noMonitor = advanceCrackExtra(extraId, 1, {})
check('缺监测人被拒绝', !noMonitor.ok, noMonitor.message)
const toConsult = advanceCrackExtra(extraId, 1, { 监测人: '赵敏', 处理备注: '安排每日两次量测' })
check('待判定→会诊', toConsult.ok, toConsult.message)
const noResult = advanceCrackExtra(extraId, 2, {})
check('缺加测结果被拒绝', !noResult.ok, noResult.message)
const toRemeasure = advanceCrackExtra(extraId, 2, { 加测结果: '当前宽度 19.2mm' })
check('会诊→复测', toRemeasure.ok, toRemeasure.message)
const toVerify = advanceCrackExtra(extraId, 3, {})
check('复测→校核', toVerify.ok, toVerify.message)
const beyond = advanceCrackExtra(extraId, 4, {})
check('终态拒绝再流转', !beyond.ok, beyond.message)
const generic = runAction('crack_extra', extraId, '提交会诊')
check('通用动作也拦跳阶段', !generic.ok, generic.message)

// ---------- 5. 观测提交 + 复测不覆盖原始值 ----------
console.log('== 观测提交/复测留痕 ==')
const bad = submitObservation({ 隐患点编号: 'HAZA-0001', 观测日期: '2026-10-05', 水平位移量: 'abc', 垂直位移量: '1', 裂缝宽度: '2', 变化速率: '0.1', 观测人: '张明' })
check('非法数值被拒绝', !bad.ok, bad.message)
const sub = submitObservation({ 隐患点编号: 'HAZA-0001', 观测日期: '2026-10-05', 水平位移量: '30', 垂直位移量: '40', 裂缝宽度: '6', 变化速率: '0.6', 观测人: '张明' })
check('观测提交成功并生成会诊单', sub.ok && sub.message.includes('CONS-0004'), sub.message)
const c4 = listEntries('consultation').items.find((r) => r['会诊编号'] === 'CONS-0004')!
check('合成位移=50→警示级', c4['位移值'] === 50 && c4['位移等级'] === '警示级', `${c4['位移值']}/${c4['位移等级']}`)
const c4id = Number(c4.id)
const rv = submitConsultReview(c4id, 1, {
  位移: { 结论: '复测', 理由: '雨量突增，需复测确认' },
  裂缝宽度: { 结论: '采纳', 理由: '与游标卡尺一致' },
  速率: { 结论: '采纳', 理由: '在阈值配置范围内' },
}, '张明')
check('会诊（含复测项）成功', rv.ok, rv.message)
const defo4 = listEntries('deformation').items.find((r) => r['记录编号'] === 'DEFO-0004')!
check('形变记录转需复测', defo4.status === '需复测', defo4.status)
const rm1 = registerRemeasure(c4id, 2, { 位移: '12', 裂缝宽度: '', 速率: '' }, '张明')
check('复测登记成功', rm1.ok, rm1.message)
const c4after = listEntries('consultation').items.find((r) => Number(r.id) === c4id)!
check('原始值冻结 50，复测值另存 12', c4after['位移值'] === 50 && c4after['复测值_位移'] === 12, `原始${c4after['位移值']} 复测${c4after['复测值_位移']}`)
check('复测等级重算为正常', c4after['复测等级_位移'] === '正常', String(c4after['复测等级_位移']))
const vf4 = completeConsultVerification(c4id, 3, '王强')
check('校核后最终等级=注意级（复测优先）', vf4.ok && vf4.message.includes('注意级'), vf4.message)
check('注意级不生成加测单', listEntries('crack_extra').items.length === 1)

// ---------- 6. 写入失败整体回退 ----------
console.log('== 事务回退 ==')
const before = {
  defo: listEntries('deformation').items.length,
  consult: listEntries('consultation').items.length,
  extra: listEntries('crack_extra').items.length,
}
failWrites = true
const rolled = submitObservation({ 隐患点编号: 'HAZA-0001', 观测日期: '2026-10-05', 水平位移量: '1', 垂直位移量: '1', 裂缝宽度: '1', 变化速率: '0.1', 观测人: '张明' })
failWrites = false
check('写入失败返回回退提示', !rolled.ok && rolled.message.includes('回退'), rolled.message)
const after = {
  defo: listEntries('deformation').items.length,
  consult: listEntries('consultation').items.length,
  extra: listEntries('crack_extra').items.length,
}
check('回退后各模块数量不变', before.defo === after.defo && before.consult === after.consult && before.extra === after.extra, JSON.stringify({ before, after }))

console.log(`\n结果：${passed} 通过，${failed} 失败`)
process.exit(failed > 0 ? 1 : 0)
