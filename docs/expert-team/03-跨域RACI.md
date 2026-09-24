# 03 · 跨域 RACI（一事一 A）

> 对应《体系文档》第 5 节。机器可读版见 `raci/RACI矩阵.csv`。

## 1. 角色定义

| 角色 | 含义 | 谁能持有 |
| --- | --- | --- |
| **A**（Accountable） | 最终担责，唯一 | 仅人类首席 |
| **R**（Responsible） | 负责执行 | 人类专家 + Agent |
| **C**（Consulted） | 事前咨询 | 相关域 |
| **I**（Informed） | 事后知会 | 相关域 |

- Agent 只写 **R** 或 **C**，**不写 A**。
- 每个事项**仅 1 个 A**；出现两个 A 即重拆。
- C 过多应瘦身，只保留真正要事前咨询的域。

## 2. 跨域 RACI 分配表

| 事项 | A | R | C | I |
| --- | --- | --- | --- | --- |
| 需求范围 | 产品 | 产品Agent/产品 | 架构/各域/UI/QA/安全/合规 | 全员 |
| 排期与里程碑 | PMO | PMO | 产品/各首席 | 治理委 |
| 总体架构/ADR/选型 | 架构 | 各首席 | 产品/安全/DBA/DevOps/合规 | PMO/QA |
| Web前端 | 前端Web | 前端Web Agent/人 | UI/BFF/性能前端/DevOps | QA |
| 组件/跨端 | 组件首席 | 组件Agent | UI/Web/业务前端 | QA/DevOps |
| 前端性能安全 | 性能安全首席 | Agent | Web/组件/UI/安全/DevOps | QA |
| iOS/Android | 对应移动首席 | 移动Agent | UI/后端/DevOps/安全 | QA |
| 后端身份/事务/读扩/集成 | 对应域首席 | 域Agent | 架构/DBA/安全/QA | PMO |
| 测试功能放行 | QA治理 | QA/开发 | 架构/产品/安全/合规/DevOps | PMO |
| 性能容量放行 | QA性能 | QA/开发 | 架构/DevOps/DBA | 产品/PMO |
| 发布与生产稳定 | DevOps | DevOps Agent | 架构/各开发/DBA/安全/QA | 产品/PMO |
| 数据库/数据管道 | DBA | DBA Agent | 后端/架构/安全/合规 | QA/PMO |
| 安全漏洞/SDL | 安全 | 安全Agent | 架构/DevOps/各开发/DBA/合规 | QA/PMO |
| 个保/PIA/等保/密评/审计 | 合规 | 合规Agent | 安全/DBA/架构/产品/QA | 全员 |
| 文档/知识资产 | 文档 | 文档Agent | 架构/各开发/安全/合规/DevOps | 全员 |

## 3. 规则

1. 出现两个 A → **重拆**（重新定义事项边界或细分活动）；
2. C 过多 → **瘦身**（移除只在 R 上有意见的域，改走 I）；
3. Agent 只出现在 **R / C** 列，绝不占 A；
4. 跨域争议由技术治理委员会**仲裁活动边界**，不替代各 A 的最终责任。