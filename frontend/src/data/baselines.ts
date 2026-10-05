import type { EntryRow } from './types'

// 形变观测阈值会诊的分级基线。
// 查找顺序：① 预警阈值模块中该隐患点+监测类型的「已生效」配置；② 命中不到时，
// 按观测日期匹配当时有效的基线版本补算（旧记录没有阈值配置也走这条）。

export type GradeLevel = '正常' | '注意级' | '警示级' | '警戒级'

export const GRADE_ORDER: GradeLevel[] = ['正常', '注意级', '警示级', '警戒级']

export type ConsultItemKey = '位移' | '裂缝宽度' | '速率'

export const CONSULT_ITEMS: { key: ConsultItemKey; unit: string; desc: string }[] = [
  { key: '位移', unit: 'mm', desc: '水平与垂直位移的合成位移' },
  { key: '裂缝宽度', unit: 'mm', desc: '裂缝当前宽度' },
  { key: '速率', unit: 'mm/d', desc: '变化速率' },
]

export type GradeBand = { 注意级: number; 警示级: number; 警戒级: number }

export type BaselineVersion = {
  version: string
  /** 生效日期（含当天），按观测日期取「当时有效」的版本 */
  effectiveFrom: string
  bands: Record<ConsultItemKey, GradeBand>
}

export const BASELINE_VERSIONS: BaselineVersion[] = [
  {
    version: '基线V2025',
    effectiveFrom: '2025-01-01',
    bands: {
      位移: { 注意级: 30, 警示级: 50, 警戒级: 80 },
      裂缝宽度: { 注意级: 8, 警示级: 20, 警戒级: 40 },
      速率: { 注意级: 0.8, 警示级: 1.5, 警戒级: 3.0 },
    },
  },
  {
    version: '基线V2026',
    effectiveFrom: '2026-01-01',
    bands: {
      位移: { 注意级: 20, 警示级: 40, 警戒级: 60 },
      裂缝宽度: { 注意级: 5, 警示级: 15, 警戒级: 30 },
      速率: { 注意级: 0.5, 警示级: 1.0, 警戒级: 2.0 },
    },
  },
]

/** 观测日期落在哪个版本的生效期内，就用哪个版本；早于所有版本时用最早一版。 */
export function baselineFor(observeDate: string): BaselineVersion {
  const sorted = [...BASELINE_VERSIONS].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))
  let picked = sorted[0]
  for (const version of sorted) {
    if (version.effectiveFrom <= observeDate) {
      picked = version
    }
  }
  return picked
}

export function gradeOf(value: number, band: GradeBand): GradeLevel {
  if (value >= band.警戒级) return '警戒级'
  if (value >= band.警示级) return '警示级'
  if (value >= band.注意级) return '注意级'
  return '正常'
}

export function maxGrade(grades: GradeLevel[]): GradeLevel {
  return grades.reduce<GradeLevel>(
    (top, grade) => (GRADE_ORDER.indexOf(grade) > GRADE_ORDER.indexOf(top) ? grade : top),
    '正常',
  )
}

/** 合成位移 = √(水平² + 垂直²)，保留 1 位小数。 */
export function composeDisplacement(horizontal: number, vertical: number): number {
  return Math.round(Math.sqrt(horizontal * horizontal + vertical * vertical) * 10) / 10
}

function parseBand(row: EntryRow): GradeBand | null {
  const band = {
    注意级: Number(row['注意级阈值']),
    警示级: Number(row['警示级阈值']),
    警戒级: Number(row['警戒级阈值']),
  }
  const valid =
    [band.注意级, band.警示级, band.警戒级].every((v) => Number.isFinite(v) && v >= 0) &&
    band.注意级 <= band.警示级 &&
    band.警示级 <= band.警戒级
  return valid ? band : null
}

/**
 * 解析某个会诊项目该用哪档阈值：先找阈值模块里该隐患点已生效的配置（取编号最新的一条），
 * 找不到再按观测日期落到当时有效的基线版本。source 记录来源，随单据留痕。
 */
export function resolveBand(
  itemKey: ConsultItemKey,
  hazardId: string,
  observeDate: string,
  thresholdRows: EntryRow[],
): { band: GradeBand; source: string } {
  const matched = thresholdRows
    .filter(
      (row) =>
        String(row['隐患点编号']) === hazardId &&
        String(row['监测类型']) === itemKey &&
        String(row['生效状态']) === '已生效',
    )
    .map((row) => ({ row, band: parseBand(row) }))
    .filter((item): item is { row: EntryRow; band: GradeBand } => item.band !== null)
    .sort((a, b) => Number(b.row.id) - Number(a.row.id))
  if (matched.length > 0) {
    return { band: matched[0].band, source: `阈值${matched[0].row['阈值编号']}` }
  }
  const baseline = baselineFor(observeDate)
  return { band: baseline.bands[itemKey], source: baseline.version }
}

export type GradeResult = {
  grades: Record<ConsultItemKey, GradeLevel>
  suggestion: GradeLevel
  source: string
}

/** 对位移、裂缝宽度、速率逐项分级，自动建议取三项中的最高等级。 */
export function gradeConsultation(
  values: Record<ConsultItemKey, number>,
  hazardId: string,
  observeDate: string,
  thresholdRows: EntryRow[],
): GradeResult {
  const grades = {} as Record<ConsultItemKey, GradeLevel>
  const sources: string[] = []
  for (const item of CONSULT_ITEMS) {
    const { band, source } = resolveBand(item.key, hazardId, observeDate, thresholdRows)
    grades[item.key] = gradeOf(values[item.key], band)
    sources.push(`${item.key}:${source}`)
  }
  return { grades, suggestion: maxGrade(Object.values(grades)), source: sources.join('；') }
}
