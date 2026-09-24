# 20人资深专家＋专家Agent体系（可执行版）

本仓库将《20人资深专家＋专家Agent体系文档（合并版）》从一份规范文档落地为**两套可执行资产**：

| 资产 | 位置 | 用途 |
| --- | --- | --- |
| 跨平台配置包 | `docs/expert-team/` | 21 张卡片系统提示词（00-路由Agent + 20 张岗位卡）、主文档、RACI 矩阵 CSV、门禁与落地清单。可直接导入 **Dify / Coze / LangGraph / AutoGen / GitLab Duo / 内部自研 Agent 平台** |
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
│   ├── agent-cards/                           # 21 张卡：00-路由Agent + 20 张岗位卡
│   │   ├── 00-路由Agent.md ... 20-技术文档知识治理.md
│   ├── roster/                                # 首席名册（正式落聘版，单一事实源）
│   │   ├── 首席名册.md
│   │   └── 首席名册.csv
│   └── raci/
│       └── RACI矩阵.csv                       # 机器可读 RACI
├── scripts/
│   ├── sync-roster.mjs                        # 名册 → 岗位卡/Agent/路由表 同步
│   └── validate-expert-team.mjs               # 一致性校验：结构/编号/引用/RACI双写/名册/MCP权限
└── .opencode/                                 # ── OpenCode Agent 版 ──
    ├── opencode.jsonc                         # MCP 接入样例（Jira+GitLab，默认 disabled）
    ├── agents/router.md                       # 路由Agent：只分诊、不持A，按RACI派单
    └── agents/expert/                         # 20 个专家子Agent（只读）
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

- 主会话内直接说：`把当前改动交给 expert/18-security 评审`、`让路由Agent按RACI派单评审这次需求`、`让 expert/14-qa-governance 检查合规测试用例（同意/注销/导出/保留）缺口`。
- 也可把会话主 Agent 切到 `router`（路由），按 RACI 自动派单给 20 个专家子 Agent。
- 所有专家 Agent 均默认**只读**（read/glob/grep），安全/合规/架构/iOS/Android/前端性能安全 6 岗额外开放 web 检索（只读）；不做任何写操作。系统提示词具备「不编造、无工具数据不输出指标、高风险只出建议并升级」等约束。
- 提示词中「公司」为通用占位，无需替换；跨平台岗位卡中才是 `{公司}` 模板变量。

### C. 日常维护

- 改动任何岗位定义（岗位卡/OpenCode Agent/RACI）后，运行一致性校验：
  `node scripts/validate-expert-team.mjs`（校验编号、frontmatter、路由引用、命名对应、RACI 双写一致、名册、MCP 权限）。
- 生产/个保/等保/安全放行均走人工签批，Agent 只出建议；跨域争议交技术治理委员会。

### D. 接入 Jira / GitLab（可选，样例已就绪）

样例配置在 `.opencode/opencode.jsonc`（`mcp.servers.gitlab/jira`），**默认 disabled**，不影响未接入时启动。启用三步：

1. 配好环境变量（一律用 `{env:...}` 代入，**严禁把明文密钥写进 jsonc**）：
   - GitLab：`GITLAB_PERSONAL_ACCESS_TOKEN`、`GITLAB_API_URL`；
   - Jira：`JIRA_URL`、`JIRA_EMAIL`、`JIRA_API_TOKEN`（命令为社区样例 `sooperset/mcp-atlassian`，命令与变量以你所选服务器文档为准；server 名保持 `jira` 即可不动 Agent 权限）。
2. 把对应 server 的 `"disabled": true` 改成 `false`，重启 OpenCode，`opencode mcp list` 应显示 `connected`；
3. 用法示例：`让 expert/18-security 评审 MR !123 的改动`、`让 expert/14-qa-governance 拉取 Jira 需求清单核对测试策略`。

**只读保证**：专家 Agent 的 permissions 只放行 `gitlab_/jira_` 的 `get_*/list_*/search_*`——即使服务器暴露建单/评论等写工具，也在 Agent 层被默认 `deny *` 兜底拦下（校验脚本第 9 节强制检查）。

> 路由 Agent 与专家 Agent 的详细说明见 `.opencode/agents/` 下各文件头注释与正文「权威口径」段。

## 20 岗速览

| # | 岗位卡 | 专家Agent（域） | 人类A |
| --- | --- | --- | --- |
| 01 | 产品 | 需求范围/优先级/指标树/版本路线/需求准入门禁 | 首席产品 · 陈亦凡 |
| 02 | 交付/PMO | 里程碑/资源容量/跨域依赖/变更/范围/上线三闸 | 首席PMO · 林若曦 |
| 03 | UIUX | 信息架构/Figma/WCAG/设计系统门禁/同意旅程 | 首席UIUX · 沈清和 |
| 04 | 前端Web | React/Vue/Next、SSR/微前端/BFF/性能预算 | 前端Web首席 · 周子墨 |
| 05 | 前端组件/跨端 | Storybook/设计—代码映射/小程序/低代码/Monorepo | 组件首席 · 吴景行 |
| 06 | 前端性能/安全 | 首屏/包体/XSS/CSP/SCA/第三方SDK准入 | 前端性能安全首席 · 郑思远 |
| 07 | iOS | Swift/模块化/离线/生物认证/商店隐私 | iOS首席 · 孙嘉树 |
| 08 | Android/跨平台 | Kotlin/Flutter/RN/碎片化/商店合规 | Android/跨平台首席 · 何见微 |
| 09 | 后端身份/平台 | OAuth/JWT/RBAC/多租户/网关/零信任 | 身份首席 · 冯致远 |
| 10 | 后端重事务 | DDD/Saga/分布式事务幂等/对账/资损 | 事务域首席 · 蒋澜 |
| 11 | 后端重读扩 | Redis/ES/CQRS/缓存分层/热点/搜索 | 读扩域首席 · 韩深 |
| 12 | 后端集成/数据服务 | REST/gRPC/事件/Schema/数据契约/第三方 | 集成首席 · 唐予安 |
| 13 | 架构治理 | 企业架构/云原生/微服务/ADR/成本—风险—速度 | 首席架构 · 曹立言 |
| 14 | QA测试治理 | 测试策略/自动化/契约/合规测试映射/逃逸 | 测试治理首席 · 许望舒 |
| 15 | QA性能/可靠 | 容量模型/压测/SLO/混沌 | 性能可靠首席 · 邓启明 |
| 16 | DevOps/SRE | K8s/CI/CD/GitOps/可观测/错误预算/回滚 | DevOps首席 · 崔明澈 |
| 17 | DBA/数据工程 | 实例性能/备份RPO-RTO/分库分表/脱敏/血缘 | DBA首席 · 苏时雨 |
| 18 | 安全 | OWASP/SAST-DAST-SCA/威胁建模/零信任/等保技术 | 安全首席 · 罗承嗣 |
| 19 | 合规/个保 | 个保法/PIA/分类分级/同意与权利/跨境/等保密评 | 合规首席/个保负责人 · 高叙 |
| 20 | 技术文档/知识治理 | OpenAPI/ADR归档/Runbook/发布说明/审计证据 | 文档首席 · 萧云衢 |