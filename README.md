# 地质灾害隐患点监测防治管理系统

面向地质灾害隐患点形变裂缝观测、雨量预警、避险搬迁安置与治理工程验收全流程的地质灾害防治数字化管理平台。

这是一个**纯前端**管理平台：Vue 3 + Vite + TypeScript，仓库里没有后端服务。业务数据由
`frontend/src/data/` 下的本地数据层提供：首次打开用示例数据播种，之后的登记、筛选与状态流转
结果都持久化在浏览器 `localStorage` 里，刷新或重开浏览器都还在。dev server 已关掉自动打开页面，
启动后按终端打印的地址手工打开。

## 目录结构

```text
.
├── frontend/                 Vue 3 + Vite + TypeScript 前端（唯一运行单元）
│   ├── src/views/            每个业务模块一个页面
│   ├── src/api/local-service.ts   本地数据服务：列表、筛选、动作流转、导出
│   ├── src/data/             模块元数据 / 示例数据 / localStorage 持久化
│   ├── src/stores/           会话与筛选状态
│   └── vite.config.ts        dev server 配置（open: false，无 /api 代理）
├── .gitignore
└── docker-compose.yml
```

## 启动

```bash
cd frontend
npm install
npm run dev
```

前端默认监听 `http://127.0.0.1:5173/`，dev server 不会自动打开浏览器，需要自己访问。

生产构建：

```bash
cd frontend
npm run build
```

## 业务模块

| 模块 | 目录 | 业务对象 | 主要字段 |
| --- | --- | --- | --- |
| 隐患点台账 | `hazard` | 隐患点 | 隐患点编号、隐患点名称、灾害类型 |
| 形变观测 | `deformation` | 形变记录 | 记录编号、隐患点编号、观测日期 |
| 阈值会诊 | `consultation` | 会诊单 | 会诊单号、记录编号、自动综合建议、最终分级 |
| 裂缝监测 | `crack` | 裂缝测点 | 测点编号、隐患点编号、裂缝编号 |
| 裂缝加测 | `crack_extra` | 加测单 | 加测单号、会诊单号、加测原因、触发级别 |
| 倾斜监测 | `tilt` | 倾斜记录 | 记录编号、测点编号、观测方向 |
| 雨量监测 | `rain_gauge` | 雨量记录 | 记录编号、站点编号、观测时段 |
| 预警阈值 | `threshold` | 预警阈值 | 阈值编号、隐患点编号、监测类型 |
| 预警发布 | `alarm` | 预警通知 | 通知编号、隐患点编号、预警等级 |
| 避险搬迁 | `evacuation` | 搬迁安置户 | 户号、所属隐患点、户主姓名 |
| 巡查排查 | `patrol` | 巡查记录 | 巡查编号、隐患点编号、巡查日期 |
| 治理工程 | `engineering` | 治理工程项目 | 项目编号、隐患点编号、治理方案 |
| 工程验收 | `acceptance` | 验收报告 | 验收编号、项目编号、验收类型 |
| 整改跟踪 | `rectification` | 整改任务 | 任务编号、验收编号、整改内容 |
| 应急演练 | `drill` | 演练记录 | 演练编号、隐患点编号、演练主题 |
| 监测设备 | `device` | 监测设备 | 设备编号、设备类型、所属隐患点 |
| 灾情速报 | `report` | 灾情速报 | 速报编号、隐患点编号、发生时间 |
| 防灾宣传 | `propaganda` | 宣传活动 | 活动编号、宣传主题、宣传方式 |
| 承建单位 | `contract` | 承建单位 | 单位编号、单位名称、资质等级 |
| 群测群防培训 | `training` | 培训记录 | 培训编号、培训主题、培训对象 |

## 约定

- 每个模块的页面在 `frontend/src/views/<模块>/index.vue`，页面只负责渲染，读写统一走
  `frontend/src/api/local-service.ts`。
- 字段、状态、动作与流转目标集中在 `frontend/src/data/modules.ts`；示例数据在
  `frontend/src/data/seed.ts`。
- 状态流转只允许在 `local-service.ts`（通用动作）和 `consultation-service.ts`（会诊领域流转）里改，
  页面组件不做业务判断。
- 想回到初始数据：清掉浏览器里 `geohazard-monitor-prevention:entries:v2` 这一项，或调用 `resetModule(模块)`。
- 领域规则测试：`cd frontend && npm test`（纯 node 运行，不依赖浏览器）。

## 阈值会诊队列（形变观测 ↔ 裂缝监测）

### 调用关系

```text
形变观测页 ── submitObservation（登记观测）/ createConsultationForRecord（旧记录补会诊）
    │        入口：api/consultation-service.ts
    ├─→ deformation 形变记录（已观测）
    ├─→ consultation 会诊单（待判定）：原始值快照 + 基线快照 + 逐项自动分级建议
    └─→ crack_extra 加测待办（待判定）：裂缝宽度或速率达注意级及以上时同一事务同步生成
阈值会诊页 ── submitDecisions / advanceToRemeasure / submitRemeasure：会诊单逐阶推进
裂缝监测页 ── advanceExtra：加测待办走同一套状态机独立推进
形变记录「确认校核」（local-service.runAction）
    └─→ assertDeformationVerifyAllowed 守卫：关联会诊单未到「校核」即拒绝
```

### 业务规则

- **分级建议**：录入位移（水平/垂直取大者）、裂缝宽度、变化速率后，按阈值基线自动分出
  正常/注意级/警示级/警戒级，逐项给出建议。
- **人工优先**：自动建议与人工判定冲突时以人工判定为准——观测人必须逐项选择「采纳」或
  「复测」并填写理由；自动建议留痕，最终分级与自动综合建议不一致的会诊单打冲突标记
  （`abnormal`），在运营概览可见。
- **原始值不覆盖**：原始观测值随会诊单快照保存，复测值另存字段，任何阶段不改写原始值。
- **旧记录补算**：历史记录没有阈值快照，发起会诊时按观测日期取当时有效的阈值基线
  （`baselineAt`）补算分级；观测日期早于所有基线时退用最早一版。
- **状态机**：会诊单与加测待办都必须依次经过 待判定→会诊→复测→校核，只允许逐阶推进，
  越过阶段即拒绝；全部采纳的会诊单也必须经过复测阶段（自动标注"无复测项"）。
- **并发首版本**：同一形变记录只允许存在一张会诊单，重复发起被拒绝；每次变更携带期望
  版本号（`version`），版本不匹配的旧提交被拒绝，仅保留首个版本。
- **整体回退**：观测提交、会诊建单、加测待办生成等多表写入包在 `transact` 事务里，
  任一步失败即恢复进入事务前的快照，不产生半截数据。

