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
| 阈值会诊 | `consultation` | 会诊单 | 会诊编号、记录编号、自动建议、最终等级 |
| 裂缝监测 | `crack` | 裂缝测点 | 测点编号、隐患点编号、裂缝编号 |
| 裂缝加测 | `crack_extra` | 加测单 | 加测编号、来源会诊编号、隐患点编号 |
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
- 状态流转只允许在 `local-service.ts` 里改，页面组件不做业务判断。
- 想回到初始数据：清掉浏览器里 `geohazard-monitor-prevention:entries` 这一项，或调用 `resetModule(模块)`。

## 阈值会诊链路（形变观测 → 会诊 → 裂缝加测）

观测提交、校核、裂缝监测加测单之间的调用关系全部收口在 `local-service.ts`：

1. **观测提交**（`submitObservation`）：形变观测页录入位移（水平/垂直）、裂缝宽度、变化速率后，
   同一事务内登记形变记录并生成**待判定**会诊单，自动算出分级建议（正常/注意级/警示级/警戒级，
   位移取水平与垂直的合成位移）。
2. **会诊**（`submitConsultReview`）：观测人对位移、裂缝宽度、速率**逐项**选择采纳或复测并填写理由，
   缺一项即拒绝。**自动建议与人工判断冲突时，人工逐项结论优先**，自动建议只留作对照；
   原始观测值冻结在会诊单上，后续复测值另存字段、版本号递增，绝不覆盖原始值。
3. **复测**（`registerRemeasure`）：对判定复测的项目登记复测值，按同一基线重算等级。
4. **校核**（`completeConsultVerification`）：定最终等级（复测项以复测实测为准），形变记录转为已校核；
   最终等级达**警示级及以上**时，同一事务内在裂缝监测侧生成**加测单**（待判定）。
5. **加测单流转**（`advanceCrackExtra`）：与会诊单一样，状态必须依次经过
   **待判定→会诊→复测→校核**，越过阶段即拒绝（`modules.ts` 里 `strictSequence: true`，
   通用 `runAction` 也会拦截跳阶段操作）。

配套规则：

- **阈值来源**：先查预警阈值模块中该隐患点+监测类型的「已生效」配置；查不到（含旧记录无阈值）时，
  按观测日期匹配 `src/data/baselines.ts` 中**当时有效**的基线版本补算，来源随单据留痕。
  会诊页提供「旧记录补算」（`backfillConsultations`）为历史形变记录补建会诊单。
- **并发提交仅保留首个版本**：会诊单、加测单都带版本号，提交时校验，版本不一致即拒绝。
- **写入失败整体回退**：跨模块多步写入一律走 `local-store.ts` 的 `withTransaction`，
  任何一步失败，内存缓存与 localStorage 一起恢复到进入前快照。
