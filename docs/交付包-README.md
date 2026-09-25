# 20人资深专家＋专家Agent体系 · 交付包

版本：2026-09-25　·　依据《20人资深专家＋专家Agent体系文档（合并版）》

## 包内含两套可执行资产 + 运维脚本

| 资产 | 位置 | 用途 |
| --- | --- | --- |
| 跨平台配置包 | `跨平台配置包/docs/expert-team/` | 21 张卡（00-路由Agent + 20 岗位卡）、主文档 00~05、RACI 矩阵 CSV、首席名册、审计/审批台账。导入 **Dify / Coze / LangGraph / AutoGen / GitLab Duo / 自研平台** |
| OpenCode Agent 版 | `OpenCode-Agent版/.opencode/` | 1 个路由 Agent（primary，自主派单留痕）+ 20 个专家子 Agent（subagent，只读）+ `opencode.jsonc`（`default_agent=router`，MCP gitlab/jira 默认 disabled 样例） |
| 运维脚本 | `scripts/` | `validate-expert-team.mjs`（38 项一致性校验）、`sync-roster.mjs`（名册 → 岗位卡/Agent/路由表同步）、`autodispatch-watcher.mjs`（本地 git 新提交 → 自主派单监听，零凭据） |

## 快速导入

### A. 跨平台（Dify / Coze / LangGraph / 自研）
1. 读 `跨平台配置包/docs/expert-team/01-统一Agent骨架.md` 作为平台级骨架模板；
2. 逐岗复制 `跨平台配置包/docs/expert-team/agent-cards/XX-*.md` 正文到对应 Agent 系统提示词，替换 `{公司}` 占位符；
3. 把 `跨平台配置包/docs/expert-team/raci/RACI矩阵.csv` 导入工单类型 / 发布检查单；
4. 按 `05-落地清单与度量.md` 先只读试点、再放开中风险写操作。

### B. OpenCode
1. 把 `OpenCode-Agent版/.opencode/` 与 `scripts/` 复制到目标仓库根目录；
2. 新会话默认由 `router` 接管（`default_agent: router`），输入即自动分诊派单并在 `docs/expert-team/runbook/` 审计留痕；
3. 常驻监听本地新提交：`node scripts/autodispatch-watcher.mjs --interval 60`；
4. 自检：`node scripts/validate-expert-team.mjs`（应 38 通过 / 0 失败）。

## 治理边界（不随部署而放宽）
- **一事一 A**：每事项仅 1 个人类 Accountable；Agent 只写 R/C，永远不占 A、不代签、不放行；
- **默认只读**：Agent 最小权限；router 是全体系唯一拿到写白名单的 Agent，且只有两个文件（`runbook/派单日志.md`、`runbook/待签批清单.md`），签批台账 `runbook/审批记录.md` 仅人类维护；
- **7 道强制门禁**：需求→开发→测试→性能→安全→合规→发布，任一不过不进下一阶段；
- **结论四态**：专家建议一律「建议批准/有条件/驳回/需人工」，生产/个保/等保/安全高危待人类首席签批；
- 派单→待签批→审批的证据链：`派单日志.md → 待签批清单.md → 审批记录.md`。

## 维护约定
- **姓名是拟名占位**：正式任命前请用真实名册替换（改 `跨平台配置包/docs/expert-team/roster/首席名册.csv` → 运行 `sync-roster.mjs` → 跑校验）。
- 改动任何岗位定义后，先跑 `validate-expert-team.mjs` 再发布。