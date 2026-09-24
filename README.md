# 20人资深专家＋专家Agent体系（可执行版）

本仓库将《20人资深专家＋专家Agent体系文档（合并版）》从一份规范文档落地为**两套可执行资产**：

| 资产 | 位置 | 用途 |
| --- | --- | --- |
| 跨平台配置包 | `docs/expert-team/` | 20 张岗位卡系统提示词、主文档、RACI 矩阵 CSV、门禁与落地清单。可直接导入 **Dify / Coze / LangGraph / AutoGen / GitLab Duo / 内部自研 Agent 平台** |
| OpenCode Agent 版 | `.opencode/agents/` | 本环境可直接调用的 **1 个路由 Agent + 20 个专家子 Agent**，默认只读、按岗位最小权限 |

## 目录结构

```
.
├── README.md                                  # 本文件（总入口）
├── docs/expert-team/                          # ── 跨平台配置包 ──
│   ├── 00-体系总览.md                         # 目的/范围/总原则/20岗速览
│   ├── 01-统一Agent骨架.md                    # 20岗共用骨架模板
│   ├── 02-权限-审计-升级.md                   # 身份/分级/审计/预算/升级路径/防注入
│   ├── 03-跨域RACI.md                         # RACI 规则与 A/R/C/I 分配
│   ├── 04-编排与门禁.md                       # 路由Agent/7道门禁/技术治理委员会
│   ├── 05-落地清单与度量.md                   # 落地步骤与月度度量指标
│   ├── agent-cards/                           # 20 张岗位卡（可直接作系统提示词）
│   │   ├── 01-产品专家.md ... 20-技术文档知识治理.md
│   └── raci/
│       └── RACI矩阵.csv                       # 机器可读 RACI
└── .opencode/agents/                          # ── OpenCode Agent 版 ──
    ├── router.md                              # 路由Agent：只分诊、不持A，按RACI派单
    └── expert/                                # 20 个专家子Agent（只读）
        ├── 01-product.md ... 20-docs.md
```

## 核心机制（一句话版）

- **人事分离**：每岗 = 1 名 20 年+ 人类首席（Accountable）+ 1 个专家 Agent（执行/起草/评审），Agent 永远不终审。
- **一事一 A**：每个跨域活动仅 1 个 Accountable；Agent 只写 R 或 C，不写 A。
- **默认只读**：Agent 最小权限，写操作按白名单；生产/个保/等保/安全例外一律人工双签。
- **强制门禁**：需求→开发→测试→性能→安全→合规→发布 7 道门，任一不过不进下一阶段。

## 快速上手

### A. 跨平台（Dify/Coze/LangGraph/AutoGen/自研）

1. 把 `docs/expert-team/01-统一Agent骨架.md` 作为平台级系统提示词模板；
2. 逐岗复制 `docs/expert-team/agent-cards/XX-*.md` 正文到对应 Agent 的 System Prompt，替换 `{公司}` 占位符；
3. 把 `docs/expert-team/raci/RACI矩阵.csv` 导入工单类型/发布检查单；
4. 按 `05-落地清单与度量.md` 先只读试点、再放开中风险写操作。

### B. OpenCode

- 主会话内直接说：`把当前改动交给 expert/18-security 评审`、`让路由Agent按RACI派单评审这次需求`。
- 也可把会话主 Agent 切到 `router`（路由），按 RACI 自动派单给 20 个专家子 Agent。
- 所有专家 Agent 均默认**只读**（read/glob/grep），个别岗位额外开放 web 检索；不做任何写操作。系统提示词具备「不编造、无工具数据不输出指标、高风险只出建议并升级」等约束。

> 路由 Agent 与专家 Agent 的详细说明见 `.opencode/agents/` 下各文件头注释。

## 20 岗速览

| # | 岗位卡 | 专家Agent（域） | 人类A |
| --- | --- | --- | --- |
| 01 | 产品 | 需求范围/优先级/指标树/版本路线/需求准入门禁 | 首席产品 |
| 02 | 交付/PMO | 里程碑/资源容量/跨域依赖/变更/范围/上线三闸 | 首席PMO |
| 03 | UIUX | 信息架构/Figma/WCAG/设计系统门禁/同意旅程 | 首席UIUX |
| 04 | 前端Web | React/Vue/Next、SSR/微前端/BFF/性能预算 | 前端Web首席 |
| 05 | 前端组件/跨端 | Storybook/设计—代码映射/小程序/低代码/Monorepo | 组件首席 |
| 06 | 前端性能/安全 | 首屏/包体/XSS/CSP/SCA/第三方SDK准入 | 前端性能安全首席 |
| 07 | iOS | Swift/模块化/离线/生物认证/商店隐私 | iOS首席 |
| 08 | Android/跨平台 | Kotlin/Flutter/RN/碎片化/商店合规 | Android/跨平台首席 |
| 09 | 后端身份/平台 | OAuth/JWT/RBAC/多租户/网关/零信任 | 身份首席 |
| 10 | 后端重事务 | DDD/Saga/分布式事务幂等/对账/资损 | 事务域首席 |
| 11 | 后端重读扩 | Redis/ES/CQRS/缓存分层/热点/搜索 | 读扩域首席 |
| 12 | 后端集成/数据服务 | REST/gRPC/事件/Schema/数据契约/第三方 | 集成首席 |
| 13 | 架构治理 | 企业架构/云原生/微服务/ADR/成本—风险—速度 | 首席架构 |
| 14 | QA测试治理 | 测试策略/自动化/契约/合规测试映射/逃逸 | 测试治理首席 |
| 15 | QA性能/可靠 | 容量模型/压测/SLO/混沌 | 性能可靠首席 |
| 16 | DevOps/SRE | K8s/CI/CD/GitOps/可观测/错误预算/回滚 | DevOps首席 |
| 17 | DBA/数据工程 | 实例性能/备份RPO-RTO/分库分表/脱敏/血缘 | DBA首席 |
| 18 | 安全 | OWASP/SAST-DAST-SCA/威胁建模/零信任/等保技术 | 安全首席 |
| 19 | 合规/个保 | 个保法/PIA/分类分级/同意与权利/跨境/等保密评 | 合规首席/个保负责人 |
| 20 | 技术文档/知识治理 | OpenAPI/ADR归档/Runbook/发布说明/审计证据 | 文档首席 |