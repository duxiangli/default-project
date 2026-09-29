/**
 * 专家团体系一致性校验
 * 用法：node scripts/validate-expert-team.mjs
 * 校验：Agent 文件完整性/frontmatter/路由引用/岗位卡命名/RACI 双写一致/占位符规范
 */
import { readdir, readFile as rawReadFile } from 'node:fs/promises';
import { auditWhitelist } from './lib/whitelist-audit.mjs';
import { auditHangRows } from './lib/crosscheck-hang.mjs';
import { auditApprovalBasis, viewGeneratedAt, VIEW_FILES } from './lib/approval-basis-audit.mjs';
import { isBarePlaceholder, commitHashesIn, duplicateQueueStats } from './lib/runbook.mjs';
import { auditDocAssertions } from './lib/doc-assert.mjs';
import { auditColumnShapes } from './lib/col-shape.mjs';
import { judgeHeartbeat, resolveThreshold, VERDICT } from './lib/watchdog.mjs';
import { execFileSync } from 'node:child_process';

/** 统一归一化换行：CRLF 检出（Windows）下校验结果必须与 LF 检出（Linux CI）一致 */
const rd = async (p, enc = 'utf8') => (await rawReadFile(p, enc)).replace(/\r\n/g, '\n');
import path from 'node:path';

let pass = 0;
let fail = 0;
const ok = (msg) => { pass++; console.log(`  ✅ ${msg}`); };
const bad = (msg) => { fail++; console.log(`  ❌ ${msg}`); };
const log = (msg) => console.log(msg);   // 不计分的说明行（如已知旧账的显式列出）

const agentsDir = '.opencode/agents';
const expertDir = path.join(agentsDir, 'expert');
const cardsDir = 'docs/expert-team/agent-cards';
const docDir = 'docs/expert-team';
/** 仓库根（白名单语义审计要在整棵文件树上展开模式，需要绝对根路径） */
const ROOT = process.cwd();

// ── 1. 专家 Agent 文件数量 ──
const expertFiles = (await readdir(expertDir)).filter((f) => f.endsWith('.md')).sort();
if (expertFiles.length === 20) ok(`专家 Agent 共 ${expertFiles.length} 个`);
else bad(`专家 Agent 数量应为 20，实际 ${expertFiles.length}`);

// ── 2. frontmatter 规范 ──
const expertIds = [];
for (const f of expertFiles) {
  const p = path.join(expertDir, f);
  const c = await rd(p, 'utf8');
  const m = f.match(/^(\d{2})-/);
  const issues = [];
  if (!c.startsWith('---\n')) issues.push('缺 frontmatter 起始 ---');
  if (!/^description: .+/m.test(c)) issues.push('缺 description');
  if (!/^mode: subagent$/m.test(c)) issues.push('mode 应为 subagent');
  if (!/^permissions:$/m.test(c)) issues.push('缺 permissions');
  if (!/^  - action: "\*"$/m.test(c)) issues.push('缺默认 deny');
  if (!/escalate_human\(/.test(c)) issues.push('缺 escalate_human 指令');
  if (!c.includes('# 权威口径')) issues.push('缺权威口径指针');
  if (!m) issues.push('文件名缺编号');
  if (issues.length) bad(`${f}: ${issues.join('; ')}`);
  else {
    ok(`${f}: frontmatter/口径指针规范`);
    if (m) expertIds.push(m[1]);
  }
}
const expectIds = Array.from({ length: 20 }, (_, i) => String(i + 1).padStart(2, '0'));
if (JSON.stringify(expertIds) === JSON.stringify(expectIds)) ok('专家 Agent 编号 01~20 齐全');
else bad(`编号不齐: ${expertIds.join(',')}`);

// ── 3. 路由引用 ↔ 实际文件 ──
const routerText = await rd(path.join(agentsDir, 'router.md'), 'utf8');
if (/^mode: primary$/m.test(routerText)) ok('router mode=primary');
else bad('router 应为 primary');
const fileIds = new Set(expertFiles.map((f) => f.replace(/\.md$/, '')));
const refIds = new Set([...routerText.matchAll(/\bexpert\/(\d{2}-[a-z-]+)/g)].map((x) => x[1]));
const missing = [...refIds].filter((id) => !fileIds.has(id));
const unreferenced = [...fileIds].filter((id) => !refIds.has(id));
if (!missing.length && !unreferenced.length) ok(`router 分诊表引用 20/20，无孤儿/缺失`);
else {
  if (missing.length) bad(`router 引用了不存在的 Agent: ${missing.join(',')}`);
  if (unreferenced.length) bad(`存在未被 router 引用的 Agent: ${unreferenced.join(',')}`);
}
if (/  - action: subagent[\s\S]*resource: "expert\/\*"/.test(routerText)) ok('router 仅允许调度 expert/*');
else bad('router subagent 权限缺失或非 expert/*');

// ── 4. 岗位卡数量与命名一致 ──
const cardFiles = (await readdir(cardsDir)).filter((f) => f.endsWith('.md')).sort();
if (cardFiles.length === 21) ok(`岗位卡共 ${cardFiles.length} 张（00-路由 + 01~20）`);
else bad(`岗位卡数量应为 21，实际 ${cardFiles.length}`);
const cardIdSet = new Set();
for (const f of cardFiles) {
  const c = await rd(path.join(cardsDir, f), 'utf8');
  const m = c.match(/命名：`(expert\/[\d]{2}-[a-z-]+)`/);
  if (m) cardIdSet.add(m[1]);
  else if (!f.startsWith('00-')) bad(`${f}: 缺命名字段`);
}
const alg = (a) => [...a].sort().join(',');
if (alg(cardIdSet) === alg(await (async () => {
  const set = new Set(expertFiles.map((f) => `expert/${f.replace(/\.md$/, '')}`));
  return [...set];
})())) ok('岗位卡命名与 OpenCode 专家 Agent 文件名一一对应');
else bad('岗位卡命名与专家 Agent 文件名不一致');

// ── 5. RACI CSV 结构 ──
const csv = await rd('docs/expert-team/raci/RACI矩阵.csv', 'utf8');
const lines = csv.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
if (lines.length === 16) ok(`RACI CSV 1 表头 + 15 事项`);
else bad(`RACI CSV 行数应为 16，实际 ${lines.length}`);
// 列序：0=事项 1=A 2=R 3=C 4=I —— 旧版本误取 cols[3]（C 列）却宣称校验 A 列
const csvRows = lines.slice(1).map((l) => l.split(','));
const aCol = csvRows.map((c) => c[1] || '');
if (aCol.length === 15 && aCol.every((v) => v.trim() && !/Agent/i.test(v))) ok('RACI CSV 每事项 A 列为人类，无 Agent 占 A');
else bad(`RACI CSV A 列异常（${aCol.filter((v) => !v.trim() || /Agent/i.test(v)).length} 行）`);
const csvTodo = new Set(csvRows.map((c) => c[0]));
const csvByTodo = new Map(csvRows.map((c) => [c[0], c]));

// ── 6. 03-跨域RACI.md 与 CSV 逐格一致（事项名 + A/R/C/I 四列值）──
const raciDoc = await rd(path.join(docDir, '03-跨域RACI.md'), 'utf8');
const raciLines = raciDoc.split('\n');
const headerIdx = raciLines.findIndex((l) => l.startsWith('| 事项 |') || l.startsWith('| 事项|'));
if (headerIdx === -1) bad('03-跨域RACI.md 未找到 RACI 分配表');
const tableRows = [];
const docByTodo = new Map();
for (let i = headerIdx + 1; i < raciLines.length; i++) {
  const l = raciLines[i];
  if (!l.startsWith('|')) break;
  const cols = l.split('|').map((x) => x.trim());
  if (cols[1] === '---' || cols[1] === 'A') continue;
  if (cols[1] === '') continue;
  tableRows.push(cols[1]);
  docByTodo.set(cols[1], cols);
}
const docMissing = [...tableRows].filter((t) => !csvTodo.has(t));
if (docMissing.length === 0 && tableRows.length === 15) ok('03-跨域RACI.md 与 RACI CSV 事项一致（15/15）');
else bad(`03 与 CSV 不一致或缺行: ${docMissing.join(',')}（解析到 ${tableRows.length} 行）`);
// 逐格比对 A/R/C/I（历史缺陷：只比事项名，19/20 行 C 漂移因此不可检出）
const cellDiff = [];
for (const [todo, dcols] of docByTodo) {
  const ccols = csvByTodo.get(todo);
  if (!ccols) continue;
  for (const [i, label] of [[1, 'A'], [2, 'R'], [3, 'C'], [4, 'I']]) {
    const dv = (dcols[i + 1] || '').replace(/\s/g, '');
    const cv = (ccols[i] || '').replace(/\s/g, '');
    if (dv !== cv) cellDiff.push(`${todo}.${label}：「${dcols[i + 1]}」≠「${ccols[i]}」`);
  }
}
if (cellDiff.length === 0) ok('03-跨域RACI.md 与 CSV 的 A/R/C/I 四列逐格一致');
else bad(`RACI 值漂移 ${cellDiff.length} 处: ${cellDiff.slice(0, 3).join('; ')}${cellDiff.length > 3 ? ' …' : ''}`);

// ── 6b. 路由表不得再复制 C 名单（C 唯一事实源 = CSV）──
const routerCard = await rd(path.join(cardsDir, '00-路由Agent.md'), 'utf8');
const orchestrate = await rd(path.join(docDir, '04-编排与门禁.md'), 'utf8');
const routeDrift = [];
if (/\| 事项 \| R \| C \|/.test(routerCard) || /主派 R \/ 咨询 C/.test(routerCard)) routeDrift.push('00-路由Agent卡 仍维护 C 列');
if (/\| 输入类型 \| 主派 \| 咨询（C） \|/.test(orchestrate)) routeDrift.push('04-编排与门禁 仍维护 C 列');
if (!/RACI矩阵\.csv/.test(routerText)) routeDrift.push('router.md 未指向 RACI C 唯一事实源');
if (!/RACI矩阵\.csv/.test(routerCard)) routeDrift.push('00-路由Agent卡 未指向 RACI C 唯一事实源');
if (routeDrift.length === 0) ok('三处路由表均以 RACI CSV 为 C 名单唯一事实源（无复制漂移）');
else bad(`路由表 C 名单漂移风险: ${routeDrift.join('; ')}`);

// ── 7. 占位符规范：OpenCode 内不得有 {公司}，docs 模板允许 ──
let stray = 0;
for (const f of [...routerText && [], ...expertFiles.map((f) => `expert/${f}`)]) {
  const c = f === 'router.md' ? routerText : await rd(path.join(agentsDir, f), 'utf8');
  if (c.includes('{公司}')) { stray++; bad(`${f}: 残留 {公司}`); }
}
if (!stray) ok('OpenCode Agent 无 {公司} 字面量');

// ── 8. 首席名册一致性（单一事实源） ──
const rosterCsv = await rd('docs/expert-team/roster/首席名册.csv', 'utf8');
const rosterRows = rosterCsv
  .replace(/^\uFEFF/, '')
  .trim()
  .split(/\r?\n/)
  .slice(1)
  .map((l) => l.split(','));
if (rosterRows.length === 20) ok('名册 CSV 共 20 人');
else bad(`名册 CSV 应为 20 人，实际 ${rosterRows.length}`);
const emptyFields = rosterRows.filter((r) => r.some((f) => !f.trim()));
if (emptyFields.length === 0) ok('名册字段（职位/姓名/工号/日期/签发人）无空值');
else bad(`名册存在空字段: ${emptyFields.map((r) => r[0]).join(',')}`);
const rosterMap = new Map(rosterRows.map((r) => [Number(r[0]), { role: r[2], name: r[3] }]));

const overviewText = await rd('docs/expert-team/00-体系总览.md', 'utf8');
const rosterMiss = [];
for (let i = 1; i <= 20; i++) {
  const r = rosterMap.get(i);
  if (!r) { rosterMiss.push(`缺${i}`); continue; }
  const cardFile = (await readdir(cardsDir)).find((f) => f.startsWith(String(i).padStart(2, '0') + '-'));
  const card = await rd(path.join(cardsDir, cardFile), 'utf8');
  const agent = await rd(path.join(expertDir, expertFiles.find((f) => f.startsWith(String(i).padStart(2, '0') + '-'))), 'utf8');
  if (!card.includes(`${r.role} · ${r.name}`)) rosterMiss.push(`卡${i}缺姓名`);
  if (!agent.includes(`人类首席（${r.role} · ${r.name}）`)) rosterMiss.push(`Agent${i}缺姓名`);
  if (!routerText.includes(`${r.role} · ${r.name}`)) rosterMiss.push(`router缺${r.name}`);
  if (!overviewText.includes(`${r.role} · ${r.name}`)) rosterMiss.push(`00总览缺${r.name}`);
}
const readme = await rd('README.md', 'utf8');
for (const r of rosterRows) {
  if (!readme.includes(`${r[2]} · ${r[3]}`)) rosterMiss.push(`README缺${r[3]}`);
}
if (rosterMiss.length === 0) ok('名册 ↔ 岗位卡 ↔ 专家Agent ↔ router ↔ 00总览/README 姓名一致（20/20）');
else bad(`名册传播不完整: ${rosterMiss.join('; ')}`);

// ── 9. MCP 接入样例：opencode.jsonc ↔ Agent 只读权限 ──
const mcpConfig = await rd('.opencode/opencode.jsonc', 'utf8');
const mcpIssues = [];
for (const token of ['"mcp"', '"servers"', '"gitlab"', '"jira"', '{env:GITLAB_PERSONAL_ACCESS_TOKEN}', '{env:JIRA_API_TOKEN}']) {
  if (!mcpConfig.includes(token)) mcpIssues.push(`缺 ${token}`);
}
// 谨慎：不允许出现明文密钥形态
if (!/^[^{]*"[^"]*":\s*"[^"]{8,}"/m.test(mcpConfig)) ; // 忽略宽松判断
if (mcpConfig.includes('ghp_') || mcpConfig.includes('glpat-') || /"[^"{]+":\s*"(?!\{env:)[A-Za-z0-9]{16,}"/.test(mcpConfig)) {
  mcpIssues.push('疑似明文密钥（应一律用 {env:...} 代入）');
}
if (mcpIssues.length === 0) ok('opencode.jsonc 含 mcp.servers(gitlab/jira) 且密钥一律 {env:...} 代入');
else bad(`MCP 配置问题: ${mcpIssues.join('; ')}`);

const jiraSet = new Set(['router', '01', '02', '14', '16', '18', '19', '20']);
const mcpMiss = [];
for (const f of [...expertFiles.map((x) => `expert/${x}`), 'router.md']) {
  const c = f === 'router.md' ? routerText : await rd(path.join(agentsDir, f), 'utf8');
  const num = f === 'router.md' ? 'router' : f.slice(7, 9);
  for (const t of ['gitlab_get_*', 'gitlab_list_*', 'gitlab_search_*']) {
    if (!c.includes(t)) mcpMiss.push(`${f} 缺 ${t}`);
  }
  if (jiraSet.has(num)) {
    for (const t of ['jira_get_*', 'jira_list_*', 'jira_search_*']) {
      if (!c.includes(t)) mcpMiss.push(`${f} 缺 ${t}`);
    }
  } else if (c.includes('jira_get_*')) {
    mcpMiss.push(`${f} 不应放行 jira（最小权限）`);
  }
}
if (mcpMiss.length === 0) ok('专家Agent/router 权限仅放行 gitlab/jira 只读工具（get/list/search），写工具仍被 deny');
else bad(`MCP 权限不齐: ${[...new Set(mcpMiss)].join('; ')}`);

// ── 10. 自主派单：default_agent / router 留痕白名单 / 派单日志 / 事件驱动脚本 ──
const autoIssues = [];
if (!mcpConfig.includes('"default_agent": "router"')) autoIssues.push('opencode.jsonc 缺 default_agent=router');
if (!/^  - action: edit$/m.test(routerText)) autoIssues.push('router 缺 edit 写白名单');
if (!/^  - action: write$/m.test(routerText)) autoIssues.push('router 缺 write 写白名单');
if (!routerText.includes('docs/expert-team/runbook/派单日志.md')) autoIssues.push('router 缺派单日志引用');
if (!routerText.includes('docs/expert-team/runbook/待签批清单.md')) autoIssues.push('router 缺待签批清单引用');
if (!routerText.includes('docs/expert-team/runbook/审批记录.md')) autoIssues.push('router 缺审批记录台账引用');
if (!routerText.includes('# 自主介入协议')) autoIssues.push('router 缺自主介入协议');
if (!routerText.includes('# 派单留痕')) autoIssues.push('router 缺派单留痕');
let dispatchLogText = '';
try { dispatchLogText = await rd('docs/expert-team/runbook/派单日志.md', 'utf8'); } catch { autoIssues.push('缺 派单日志.md'); }
if (dispatchLogText && !dispatchLogText.includes('<!-- dispatch-log-end -->')) autoIssues.push('派单日志缺末尾标记');
try { await rd('scripts/autodispatch-watcher.mjs', 'utf8'); } catch { autoIssues.push('缺 scripts/autodispatch-watcher.mjs'); }
if (autoIssues.length === 0) ok('自主派单：default_agent=router + 双写白名单(派单日志/待签批清单) + 事件驱动脚本就绪');
else bad(`自主派单配置不齐: ${autoIssues.join('; ')}`);

// ── 11. 审批闭环：待签批清单(router可写队列) / 审批记录(人工台账+模板) / 派单日志单号 ──
const approvalIssues = [];
let pendingText = '';
try { pendingText = await rd('docs/expert-team/runbook/待签批清单.md', 'utf8'); } catch { approvalIssues.push('缺 待签批清单.md'); }
if (pendingText && !pendingText.includes('<!-- pending-approval-end -->')) approvalIssues.push('待签批清单缺末尾标记');
if (pendingText && !/审批单号/.test(pendingText)) approvalIssues.push('待签批清单缺审批单号列');
let approvalLogText = '';
try { approvalLogText = await rd('docs/expert-team/runbook/审批记录.md', 'utf8'); } catch { approvalIssues.push('缺 审批记录.md'); }
if (approvalLogText && !/(审批单模板|签批结论四态)/.test(approvalLogText)) approvalIssues.push('审批记录缺模板/四态定义');
if (dispatchLogText && !/派单号/.test(dispatchLogText)) approvalIssues.push('派单日志缺派单号列');
if (approvalIssues.length === 0) ok('审批闭环：派单日志(派单号) → 待签批清单(router可写队列) → 审批记录(人类台账+审批单模板) 就绪');
else bad(`审批闭环不齐: ${approvalIssues.join('; ')}`);

// ── 12. 门禁阈值可判定性（7 道门禁各有唯一人类 A + 阈值 + 证据）──
const gateIssues = [];
let gateCsv = '';
try { gateCsv = (await rd(path.join(docDir, 'raci', '门禁阈值.csv'), 'utf8')).replace(/^\uFEFF/, ''); }
catch { gateIssues.push('缺 raci/门禁阈值.csv'); }
const gateRows = gateCsv.trim() ? gateCsv.trim().split(/\r?\n/).slice(1).map((l) => l.split(',')) : [];
if (gateRows.length !== 7) gateIssues.push(`门禁阈值应为 7 行，实际 ${gateRows.length}`);
const gateRolesAll = new Set(rosterRows.map((r) => r[2].trim())); // A 须是名册中的**某个**职位（门禁号与岗位号无对应关系）
const gateAs = new Map();
for (const g of gateRows) {
  const [no, name, a, threshold, evidence, auto] = g;
  if (!/^[1-7]$/.test(no || '')) gateIssues.push(`门禁号异常: ${no}`);
  if (!name) gateIssues.push(`门禁${no} 缺名称`);
  if (!a || !gateRolesAll.has(a.trim())) gateIssues.push(`门禁${no} 的 A「${a}」不在名册职位中`);
  if (!threshold || threshold.length < 20) gateIssues.push(`门禁${no} 阈值过短，不可判定`);
  if (!/[0-9]/.test(threshold || '')) gateIssues.push(`门禁${no} 阈值无任何数值`);
  if (!evidence) gateIssues.push(`门禁${no} 缺证据要求`);
  if (!/高|半自动/.test(auto || '')) gateIssues.push(`门禁${no} 缺自动化程度标注`);
  gateAs.set(no, (a || '').trim());
}
if (new Set(gateAs.values()).size !== 7) gateIssues.push('门禁 A 存在重复（一事一A）');
// 门禁认领：每道门禁在其 A 所属岗位卡上有认领声明
const gateClaim = { 1: '01-产品专家.md', 2: '13-架构治理.md', 3: '14-QA测试治理.md', 4: '15-QA性能可靠.md', 5: '18-安全专家.md', 6: '19-合规个保.md', 7: '16-DevOps-SRE.md' };
for (const [no, file] of Object.entries(gateClaim)) {
  try {
    const c = await rd(path.join(cardsDir, file), 'utf8');
    const tail = (c.split('\n').find((l) => l.startsWith('> RACI')) || '');
    if (!new RegExp(`第\\s*${no}\\s*道|认领门禁[^。]*${no}`).test(tail)) gateIssues.push(`门禁${no} 在 ${file} 无认领声明`);
  } catch { gateIssues.push(`门禁${no} 认领卡缺失: ${file}`); }
}
if (!/门禁阈值\.csv/.test(routerText)) gateIssues.push('router.md 未引用门禁阈值口径');
if (!/06-门禁阈值与判定口径\.md/.test(routerText)) gateIssues.push('router.md 未引用门禁口径文档');
if (gateIssues.length === 0) ok('门禁阈值：7 道门禁均有唯一人类 A、含数值阈值与证据要求，且各 A 岗位卡已认领');
else bad(`门禁阈值问题: ${gateIssues.join('; ')}`);

// ── 13. 术语规范 + 岗位卡结构（结论块契约 / 权威口径 / 风险档位 / 升级对象存在性）──
const termIssues = [];
const forbiddenTerms = [
  [/(?<!技术)治理委(?!员会)/, '治理委（应为技术治理委员会）'],
  [/(?<!技术)治理委员会/, '治理委员会（应为技术治理委员会）'],
  [/\|\s*低-中\s*\|/, '风险档位区间「低-中」（应为 低/中/高）'],
  [/\|\s*低-高\s*\|/, '风险档位区间「低-高」（应为 低/中/高）'],
  [/\|\s*高危\s*\|/, '风险档位「高危」（应为 高）'],
];
const scanTargets = [
  ...cardFiles.map((f) => `agent-cards/${f}`),
  '00-体系总览.md', '02-权限-审计-升级.md', '03-跨域RACI.md', '04-编排与门禁.md', '05-落地清单与度量.md', '06-门禁阈值与判定口径.md',
  'runbook/审批记录.md', 'runbook/派单日志.md', 'runbook/待签批清单.md',
];
for (const rel of scanTargets) {
  const t = await rd(path.join(docDir, rel), 'utf8');
  for (const [re, label] of forbiddenTerms) if (re.test(t)) termIssues.push(`${rel}: ${label}`);
}
if (termIssues.length === 0) ok('术语规范：无「治理委/治理委员会」变体、无低-中/低-高/高危档位');
else bad(`术语漂移 ${termIssues.length} 处: ${[...new Set(termIssues)].slice(0, 4).join('; ')}`);

// 岗位卡：结论块契约 + 权威口径 + 认领门禁/阈值引用
const cardIssues = [];
for (const f of cardFiles) {
  if (f.startsWith('00-')) continue; // 路由卡结构不同，已单独校验
  const c = await rd(path.join(cardsDir, f), 'utf8');
  const miss = [];
  if (!c.includes('<!--结论')) miss.push('缺结论块契约');
  if (!c.includes('## 权威口径')) miss.push('缺权威口径段');
  if (!c.includes('门禁阈值.csv')) miss.push('未引用门禁阈值');
  if (miss.length) cardIssues.push(`${f}: ${miss.join('/')}`);
}
if (cardIssues.length === 0) ok('20 张岗位卡均含结论块契约 + 权威口径 + 门禁阈值引用');
else bad(`岗位卡结构缺失 ${cardIssues.length} 张: ${cardIssues.slice(0, 3).join('; ')}`);

// 升级对象必须存在于名册（历史缺陷：出现「财务合规/移动首席/QA首席/性能首席」等不存在角色）
const rosterRoles = new Set(rosterRows.map((r) => r[2].trim()));
// 用前置否定环视，避免把「前端Web首席」「前端性能安全首席」误判为「Web首席/性能安全首席」
const bogusRoles = [[/(?<!前端)财务合规/, '财务合规'], [/(?<!iOS)(?<!Android\/跨平台)移动首席/, '移动首席'],
  [/(?<!测试治理)QA首席/, 'QA首席'], [/(?<!性能可靠)性能首席/, '性能首席'],
  [/(?<!前端)Web首席/, 'Web首席'], [/(?<!前端)性能安全首席/, '性能安全首席'], [/UIUX人类首席/, 'UIUX人类首席']];
const roleIssues = [];
for (const f of cardFiles) {
  const c = await rd(path.join(cardsDir, f), 'utf8');
  for (const [re, label] of bogusRoles) if (re.test(c)) roleIssues.push(`${f}: 「${label}」不在名册`);
}
if (roleIssues.length === 0) ok(`升级对象命名：20 张卡无「名册外角色」（名册 ${rosterRoles.size} 个职位）`);
else bad(`升级对象越界: ${roleIssues.join('; ')}`);

// ── 14. 自动化资产与防回退 ──
const autoAssets = [
  ['scripts/selftest.mjs', /describe|test\(|结果：/, '自测套件'],
  ['scripts/approval-sync.mjs', /签批状态视图/, '签批闭环同步'],
  ['scripts/dispatch-metrics.mjs', /度量看板/, '度量看板'],
  ['scripts/guard-audit.mjs', /契约审计/, '治理契约审计'],
  ['scripts/export-bundle.mjs', /buildZip/, '交付包导出'],
  ['scripts/export-expert-conclusions.mjs', /session['",\s]+export|OVERREACH/, '专家结论原文导出'],
  ['scripts/evidence-index.mjs', /提示词版本|输出哈希/, '证据索引生成'],
  ['scripts/ledger-doctor.mjs', /SPECS/, '台账医生'],
];
const assetIssues = [];
for (const [f, re, label] of autoAssets) {
  try { const t = await rd(f, 'utf8'); if (!re.test(t)) assetIssues.push(`${label}(${f}) 内容异常`); }
  catch { assetIssues.push(`缺 ${label}(${f})`); }
}
// watcher 加固标记（防回退）
try {
  const w = await rd('scripts/autodispatch-watcher.mjs', 'utf8');
  for (const [label, re] of [['fail-closed', /fail-closed/], ['注入隔离', /UNTRUSTED_COMMIT_DATA/], ['单实例锁', /acquireLock/], ['增量取提交', /\.\.HEAD/], ['原子写', /rename\(tmp/]])
    if (!re.test(w)) assetIssues.push(`watcher 缺加固标记：${label}`);
} catch { assetIssues.push('缺 scripts/autodispatch-watcher.mjs'); }
// 生成视图与锚点
try { const t = await rd(path.join(docDir, 'runbook', '签批状态视图.md'), 'utf8'); if (!t.includes('未闭环')) assetIssues.push('签批状态视图内容异常'); } catch { assetIssues.push('缺 签批状态视图.md（跑 approval-sync.mjs）'); }
try { const t = await rd(path.join(docDir, 'runbook', '度量看板.md'), 'utf8'); if (!t.includes('派单总量')) assetIssues.push('度量看板内容异常'); } catch { assetIssues.push('缺 度量看板.md（跑 dispatch-metrics.mjs）'); }
if (pendingText && !/DSP-YYYYMMDD-HHMM-NN|AP-YYYYMMDD-HHMM-NN/.test(pendingText)) assetIssues.push('待签批清单未声明带序号位的单号规则');
if (approvalLogText && !/approval-ledger-begin/.test(approvalLogText)) assetIssues.push('审批记录缺台账解析锚点');
if (assetIssues.length === 0) ok(`自动化资产：${autoAssets.length} 个脚本就绪 + watcher 加固在位 + 视图/锚点齐备`);
else bad(`自动化资产问题: ${assetIssues.join('; ')}`);

// 免评审白名单护栏：**正向语义判定**，不依赖任何样例（重写理由见 scripts/lib/whitelist-audit.mjs）
//
// 旧做法是「列禁止类别 + 每类取一个样例路径去试正则」，被 expert/16-devops-sre 在
// DSP-20260927-1207-01 判为「样本黑名单非语义白名单」——成立。实测可证两洞：
//   `^scripts/lib/` 命中不了样例 autodispatch-watcher.mjs → 静默豁免台账解析库；
//   `^\.opencode/agents/expert/` 命中不了样例 router.md → 静默豁免 20 个专家定义。
// 现在改为：把每条模式在**整个仓库文件树**上展开，逐个判定「是否可证为机器生成」，
// 存疑即拒；另加「匹配不到任何文件 = 死规则」判 fail。
{
  const WL = 'raci/免评审白名单.csv';
  // 注意：必须按**路径分段**精确匹配，不能用前缀正则。
  // 我第一版写 /^(\.git|dist|...)/ 结果 `\.git` 前缀命中了 `.github/`，
  // 整个 .github 目录被跳过 —— **用来堵洞的护栏自己漏掉了 CI 流水线目录**，
  // 正是它本该消除的那类盲区。
  const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'logs', 'free-model-test']);
  const walk = async (dir, base = "") => {
    const abs = path.isAbsolute(dir) ? dir : path.join(ROOT, dir);
    const out = [];
    let ents = [];
    try { ents = await readdir(abs, { withFileTypes: true }); } catch { return out; }
    for (const e of ents) {
      const rel = base ? base + '/' + e.name : e.name;
      if (SKIP_DIRS.has(e.name)) continue;
      if (e.isDirectory()) out.push(...(await walk(path.join(dir, e.name), rel)));
      else out.push(rel);
    }
    return out;
  };
  const repoFiles = await walk(ROOT);
  const headOf = async (rel) => { try { return (await rawReadFile(path.join(ROOT, rel), "utf8")).slice(0, 400); } catch { return ""; } };

  let wlCsv = '';
  try { wlCsv = await rd(path.join(docDir, WL)); }
  catch { bad('缺 ' + WL + '（免评审白名单表）'); }

  if (wlCsv) {
    const audit = await auditWhitelist(wlCsv, repoFiles, headOf);
    const okRules = audit.rules.filter((r) => r.verdict === 'OK');
    if (audit.ok) {
      ok('免评审白名单：' + okRules.length + ' 条规则，逐条在 ' + repoFiles.length
        + ' 个文件上展开后，所豁免文件**全部可证为机器生成**（非样例比对）');
      for (const r of okRules) {
        for (const p of r.gen.slice(0, 4)) log('     · 豁免 ' + p + (r.gen.length > 4 ? ' …' : ''));
      }
    } else {
      bad('免评审白名单问题 ' + audit.issues.length + ' 处: '
        + audit.issues.slice(0, 3).map((i) => i.msg).join('; ') + (audit.issues.length > 3 ? ' …' : ''));
    }
  }
}

/* ── 15. 台账表格结构（空行断表 / 列数 / 收尾竖线 / 锚点位置） ── */
{
  const structIssues = [];
  const specs = [
    ['runbook/派单日志.md', /^\| DSP-/, 9, '<!-- dispatch-log-end -->'],
    ['runbook/待签批清单.md', /^\| AP-/, 9, '<!-- pending-approval-end -->'],
    ['runbook/审批记录.md', /^\| AP-/, 13, '<!-- approval-ledger-end -->'],
    // 核对台账也纳入：2026-09-27 我在单元格里写 `grep 1.3|14 秒|41.4|秒`，
    // 3 个裸竖线把一行切成 11 列，而**当时没有任何检查发现**——它不在上面三张表里。
    // 裸竖线是「台账写入五戒」第 2 条的同款错误（列数不符会让解析器错位读列）。
    ['runbook/核对记录.md', /^\| DSP-/, 8, null],
  ];
  for (const [rel, rowRe, cols, anchor] of specs) {
    const t = await rd(path.join(docDir, rel));
    const ls = t.split('\n');
    const dataIdx = ls.map((l, i) => (rowRe.test(l) ? i : -1)).filter((i) => i >= 0);
    if (!dataIdx.length) { structIssues.push(`${rel}: 无数据行`); continue; }
    // (a) 数据行之间不得有空行——空行会把 Markdown 表断成两段，解析器只读到第一段
    for (let k = 1; k < dataIdx.length; k++) {
      if (ls.slice(dataIdx[k - 1] + 1, dataIdx[k]).some((l) => l.trim() === '')) {
        structIssues.push(`${rel}:${dataIdx[k] + 1} 前有空行，表被断开`);
      }
    }
    // (b) 列数一致 + 收尾竖线
    for (const i of dataIdx) {
      const n = ls[i].split('|').slice(1, -1).length;
      if (n !== cols) structIssues.push(`${rel}:${i + 1} 列数 ${n}≠${cols}`);
      if (!ls[i].trimEnd().endsWith('|')) structIssues.push(`${rel}:${i + 1} 缺收尾竖线`);
    }
    // (c) 锚点必须位于最后一行数据之后，否则新追加的行会被解析器忽略
    //     核对记录不用 begin/end 锚点（它是纯人读+机器读混合表，不参与追加协议），
    //     故 anchor 为 null 时跳过本项——但列数检查照做，那才是裸竖线的拦截点。
    if (anchor) {
      const aIdx = ls.findIndex((l) => l.includes(anchor));
      if (aIdx === -1) structIssues.push(`${rel}: 缺锚点`);
      else if (aIdx < dataIdx[dataIdx.length - 1]) structIssues.push(`${rel}: 锚点在末行数据之前`);
    }
  }
  if (structIssues.length === 0) ok('台账结构：四表无空行断表、列数与收尾竖线一致、锚点在末行数据之后（含核对台账列数检查）');
  else bad(`台账结构问题: ${structIssues.slice(0, 4).join('; ')}${structIssues.length > 4 ? ' …' : ''}`);

  // 语义校验：台账医生能补「列数」但不知道缺的是哪一列，补错会造成语义错位（如把依据写进建议列）
  const semIssues = [];
  const apText = await rd(path.join(docDir, 'runbook/审批记录.md'));
  for (const l of apText.split('\n')) {
    if (!/^\| AP-/.test(l)) continue;
    const c = l.split('|').slice(1, -1).map((x) => x.trim());
    if (c.length !== 13) continue;
    const id = c[0];
    // 种子行（体系初始化记录）不是一次真实派单，R/建议列天然不适用，不套派单行格式
    if (/初始化/.test(c[3] || '')) continue;
    if (!/^(AP|DSP)-\d{8}-\d{4}(-\d{2})?$/.test(id)) semIssues.push(`${id}: 单号格式异常`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(c[1])) semIssues.push(`${id}: 审批日期非 YYYY-MM-DD（实为「${c[1]}」）`);
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(c[2])) semIssues.push(`${id}: 签批时间非「日期 时:分」（实为「${c[2]}」）`);
    if (!/expert\/[a-z0-9-]+/.test(c[6])) semIssues.push(`${id}: R 列非 expert/xx（实为「${c[6]}」）`);
    if (!/^(建议批准|批准|有条件|有条件批准|驳回|需人工)(\/|$)/.test(c[8])) semIssues.push(`${id}: 专家建议列非四态（实为「${String(c[8]).slice(0, 20)}」）`);
    if (!/^(批准|有条件批准|驳回|需人工)$/.test(c[9])) semIssues.push(`${id}: 签批结论列非人类四态（实为「${String(c[9]).slice(0, 20)}」）`);
  }
  if (semIssues.length === 0) ok('台账语义：审批台账 13 列的单号/日期/时间/R/四态/结论均落在正确列');
  else bad(`台账语义错位 ${semIssues.length} 处: ${semIssues.slice(0, 3).join('; ')}${semIssues.length > 3 ? ' …' : ''}`);

  // 文档不得写死「会变的东西」（节数 / 断言数 / 耗时）
  //
  // 依据：2026-09-27 连续三轮被专家（DSP-20260927-1207-01 / 2142-01 / 2206-01）
  // 指出「文档数字漂移」——我把 validate 的节数（14）、selftest 的断言数与耗时
  // 以文字形式固化进多份文档，每加一组断言就欠一笔债。
  // 正确做法：**文档只写机制，不写数字**；数字由脚本自报、CI 日志可见。
  // 故这里做反向检查：文档里若出现硬编码的节数/断言数/耗时，一律 fail。
  const driftHits = [];
  const DRIFT_PATTERNS = [
    { re: /第\s*1\s*[~～]\s*\d+\s*节/, why: 'validate 节数区间（会随新增校验节漂移）' },
    { re: /扩(到|充至?)\s*\d+\s*节/, why: 'validate 节数（会漂移）' },
    { re: /(\d+)\s*节(体系)?(一致性)?校验/, why: 'validate 节数（会漂移）' },
    { re: /selftest[^\n]{0,20}?\d+\s*条断言/, why: 'selftest 断言数（会漂移，应由脚本自报）' },
    { re: /selftest[^\n]{0,20}?\d+(\.\d+)?\s*s\b/, why: 'selftest 耗时（会随机器漂移）' },
  ];
  const DOCS = [
    'docs/expert-team/04-编排与门禁.md', 'docs/expert-team/05-清单与参考.md',
    'docs/expert-team/06-门禁阈值与判定口径.md', 'README.md', 'docs/交付包-README.md',
    '.github/workflows/expert-guardrails.yml',
  ];
  for (const d of DOCS) {
    let txt = '';
    try { txt = await rd(path.join(ROOT, d)); } catch { continue; }
    txt.split('\n').forEach((l, i) => {
      for (const p of DRIFT_PATTERNS) {
        if (p.re.test(l)) driftHits.push(`${d}:${i + 1} 写死${p.why}：「${l.trim().slice(0, 60)}」`);
      }
    });
  }
  if (driftHits.length === 0) ok(`文档去漂移：${DOCS.length} 份文档均未写死会变的数字（节数/断言数/耗时）`);
  else bad(`文档写死了会变的数字 ${driftHits.length} 处（应改为「脚本自报」而非文字固化）: ${driftHits.slice(0, 4).join('; ')}${driftHits.length > 4 ? ' …' : ''}`);

  // (c-2) 派单时间戳不得偏离单号 HHMM 位（②）
  //
  // 背景（2026-09-27 实测）：派单号原由 router 自编，且它编的是**整点/十分**的号
  // （0100、0110、0020…），并把台账「派单时间」列填成与之自洽的值——
  // 于是「号 vs 时间列」这类自洽性检查完全查不出。真实偏差要拿 watcher 日志对才暴露：
  // DSP-20260927-0110-01 台账写 01:10，watcher 日志记 02:32:11 派单，差 82 分钟。
  // 现在派单号由脚本按真实时钟生成注入，故「号内 HHMM ≡ 时间列 HH:mm」必须成立。
  //
  // 注意本检查**只能证明内部自洽**，不能证明时间真实（真实性的唯一证据在 logs/watcher.log）。
  // 所以这里刻意不把它写成"时间已核实"，避免给出超出证据强度的保证。
  const tsIssues = [];
  const dispText = await rd(path.join(docDir, 'runbook/派单日志.md'));
  for (const l of dispText.split('\n')) {
    if (!/^\| DSP-/.test(l)) continue;
    const c = l.split('|').slice(1, -1).map((x) => x.trim());
    const m = /^DSP-(\d{8})-(\d{2})(\d{2})/.exec(c[0] || '');
    const t = /(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/.exec(c[1] || '');
    if (!m || !t) { tsIssues.push(`${c[0]}: 单号或时间列无法解析`); continue; }
    const idHm = `${m[2]}:${m[3]}`;
    if (idHm !== `${t[2]}:${t[3]}`) tsIssues.push(`${c[0]}: 号内 ${idHm} ≠ 时间列 ${t[2]}:${t[3]}`);
    if (m[1] !== t[1].replace(/-/g, '')) tsIssues.push(`${c[0]}: 号内日期 ${m[1]} ≠ 时间列日期 ${t[1]}`);
  }
  // 已知旧账白名单：这 3 处在修复（②）之前就存在，且所属审批单已由人类签批。
  // 按「已签批记录不改写」不追溯改写，但**必须显式列出**——否则等于把已知缺陷
  // 藏进白名单外装作没有。白名单外的任何不符一律 fail。
  const KNOWN_TS = {
    'DSP-20260925-1222': '号内 12:22 vs 时间列 12:21（router 自编号，②修复前）',
    'DSP-20260925-1223': '号内 12:23 vs 时间列 12:21（router 自编号，②修复前）',
  };
  const tsNew = tsIssues.filter((s) => !Object.keys(KNOWN_TS).some((k) => s.startsWith(k)));
  const tsKnown = tsIssues.length - tsNew.length;
  // 另有一类**本检查抓不到**的偏差必须显式说明：号与时间列互相自洽、但两者都≠真实派单时刻。
  // DSP-20260927-0110-01 就是这种（号 01:10 / 时间列 01:10 / 真实 02:32:11，偏差 82 分钟），
  // 故本检查**只能证内部自洽，不能证时间真实**——真实性证据在 logs/watcher.log。

  // 常驻心跳自检：watcher 是否还在跑（2026-09-28，因 14 小时静默停服而加）
  //
  // 三态判定，**UNKNOWN 绝不冒充绿灯**——logs/ 被 gitignore，CI 上没有日志是正常的，
  // 但「读不到日志」不等于「心跳正常」。把它当通过就是假保证，比没有检查更坏。
  {
    const logPath = path.join(ROOT, 'logs', 'watcher.log');
    let logText = null;
    try { logText = await rawReadFile(logPath, "utf8"); } catch { logText = null; }
    // 本机是否应当有常驻：Windows 上查计划任务；其他环境（CI/Linux）不声明
    let residentExpected = false;
    if (process.env.AUTODISPATCH_RESIDENT_EXPECTED === '1') residentExpected = true;
    else if (process.platform === 'win32') {
      try { execFileSync('powershell', ['-NoProfile', '-Command',
        "(Get-ScheduledTask -TaskName 'OpenCode-ExpertTeam-Autodispatch' -ErrorAction SilentlyContinue) -ne $null"],
        { stdio: 'ignore', timeout: 8000 }); residentExpected = true; } catch { residentExpected = false; }
    }
    const thr = resolveThreshold(Number(process.env.AUTODISPATCH_MAX_SILENCE || 0), 120);
    const hb = judgeHeartbeat({ logText, residentExpected, maxSilenceSec: thr });
    if (hb.verdict === VERDICT.FRESH) {
      ok(`常驻心跳：正常，` + hb.reason);
    } else if (hb.verdict === VERDICT.STALE) {
      bad('常驻心跳：**超过 ' + Math.round(hb.thresholdSec / 60) + ' 分钟无心跳** → ' + hb.reason);
    } else {
      // 关键：不记 ok 也不记 fail，而是显式说明无法评估——避免给出虚假安心
      log('  ⚠ 常驻心跳：**无法评估**（' + hb.reason + '）——这既不算通过也不算失败，请知悉');
    }
  }

  if (tsNew.length === 0) {
    ok('派单时间戳：无新增不符（仅证号与时间列自洽；时间真实性证据在 logs/watcher.log，本检查证不了）');
    for (const [k, why] of Object.entries(KNOWN_TS)) {
      if (tsIssues.some((s) => s.startsWith(k))) log(`  ⚠ 已知旧账 ${k}：${why}`);
    }
    if (tsKnown) log(`  ⚠ 另有一类自洽但失真：DSP-20260927-0110-01 号 01:10 / 时间列 01:10 / 真实 02:32:11（偏差 82 分钟）——本检查结构上抓不到，只能靠 watcher 日志对`);
  } else {
    bad(`派单时间戳新增不符 ${tsNew.length} 处: ${tsNew.slice(0, 4).join('; ')}${tsNew.length > 4 ? ' …' : ''}`);
  }

  // (c) 双方核对强制：每条需签批=Y 的派单都必须在「核对记录」有对应行，且不成立必须附可验证反证
  const CROSS_FILE = 'runbook/核对记录.md';
  const crossIssues = [];
  let crossText = '';
  try { crossText = await rd(path.join(docDir, CROSS_FILE)); }
  catch { crossIssues.push(`缺 ${CROSS_FILE}（双方核对台账）`); }
  if (crossText) {
    // 必备纪律条款
    for (const [label, re] of [
      ['原话留存条款', /原话留存/],
      ['不成立须附反证条款', /不成立须附反证/],
      ['禁止用相反事实代替反证', /只陈述相反事实不算反证/],
    ]) if (!re.test(crossText)) crossIssues.push(`核对记录缺「${label}」`);

    const crossRows = crossText.split('\n').filter((l) => /^\| DSP-/.test(l));
    const crossIds = new Set(crossRows.map((l) => (l.split('|')[1] || '').trim()));
    // 需签批派单直接读台账文本（不依赖外部变量，避免作用域陷阱）
    const needCross = dispatchLogText.split('\n')
      .filter((l) => /^\| DSP-/.test(l) && /\| Y\s*\|?\s*$/.test(l.trim()))
      .map((l) => (l.split('|')[1] || '').trim())
      .filter(Boolean);
    const noCross = needCross.filter((id) => !crossIds.has(id));
    if (noCross.length) crossIssues.push(`${noCross.length} 条需签批派单无核对记录: ${noCross.slice(0, 3).join(',')}`);
    // 核对结论取值受控（容忍 Markdown 加粗等包装：先剥掉 ** 与空格再判）
    for (const l of crossRows) {
      const c = l.split('|').slice(1, -1).map((x) => x.trim());
      const v = String(c[4] || '').replace(/\*\*/g, '').replace(/\s+/g, '');
      if (!/^(成立|部分成立|不成立)/.test(v)) crossIssues.push(`${c[0]}: 复核结论取值异常「${String(c[4] || '').slice(0, 16)}」`);
      // 判不成立必须有可复现的反证
      if (/^不成立/.test(v) && !/反证|ls-files|命令|输出|可复现|重跑/.test(c[5] || '')) {
        crossIssues.push(`${c[0]}: 判「不成立」但未给可验证反证`);
      }
      if (!c[2] || /^\s*$/.test(c[2])) crossIssues.push(`${c[0]}: 缺专家原始结论（不得只留复核结论）`);
      if (!c[3] || /^\s*$/.test(c[3])) crossIssues.push(`${c[0]}: 缺复核方式（须写清核了什么）`);
      // 显式堵住「播种空行」：`scripts/crosscheck-seed.mjs` 会为缺行的派单插入带「（待填）」的骨架，
      // 免得手抄单号/原文时出错。**骨架不是核对记录**——它必须被门禁挡住，否则挂账纪律
      // 会被一行空壳绕过。原先它只是**顺带**被上面的「复核结论取值」拦下，
      // 那种隐式依赖太脆：改一下取值枚举，空行就能混进来。
      //
      // ⚠ 判据必须判「**这一格就是**占位符」，不能判「**这一格提到**占位符」。
      //   我第一版写 /待填|TODO|TBD|待补/，结果在**既有行**上误报：
      //     DSP-20260927-1222-01 的处置列写着「② 文档同步**待补**」、
      //     DSP-20260927-0020-01 写着「新增待补录」——都是正常中文，不是占位符。
      //   这是本体系第 4 次栽在「关键词匹配被『只是提到』骗到」上。
      //   判定实现在 lib/runbook.mjs 的 isBarePlaceholder —— **不在这里内联**：
      //   本文件、`crosscheck-seed`、`selftest` 三方共用一份正则；两份只要有一份更宽松，
      //   这道门就形同虚设。
      for (let ci = 0; ci < c.length; ci++) {
        if (isBarePlaceholder(c[ci])) {
          crossIssues.push(`${c[0]}: 第 ${ci + 1} 列整格只是占位符「${String(c[ci]).slice(0, 12)}」`
            + '（`crosscheck-seed.mjs` 插入的骨架不算核对记录，须补齐复核方式/结论/反证/处置）');
        }
      }
    }
    if (crossIssues.length === 0) ok(`双方核对：${needCross.length} 条需签批派单全部有核对记录，复核结论取值受控、不成立均附反证`);
    else bad(`双方核对问题: ${crossIssues.slice(0, 4).join('; ')}${crossIssues.length > 4 ? ' …' : ''}`);
  }
}
/* 17. 核对记录挂账纪律（2026-09-28）：7 条「未修」实际早已完成，我差点信了那句谎话。
 * 判定逻辑见 scripts/lib/crosscheck-hang.mjs（按子句而非字符距离——子句才是语义单元）。
 * 本节只保证「没有无人处理的挂账」；**谎称已闭环它抓不到**，那要靠人核 commit。
 */
{
  const hangTxt = await (async () => { try { return await rawReadFile(path.join(docDir, 'runbook', '核对记录.md'), 'utf8'); } catch { return null; } })();
  if (hangTxt === null) {
    bad('读不到 runbook/核对记录.md（挂账纪律无从校验）');
  } else {
    const hang = auditHangRows(hangTxt);
    // ② contradictions：同一子句里既 ✅ 又「未修/挂账」= 自相矛盾。
    //   ⚠ 我第一版让 lib 返回 contradictions 却在 validate 里**只用了 issues**——
    //   那个检测等于白写。lib 写了不等于接上了，**接线处最容易漏**。
    if (hang.contradictions.length === 0) {
      ok('核对记录子句自相矛盾：0 处（无「既说已闭环又说未修/挂账」的子句）');
    } else {
      bad('核对记录有 ' + hang.contradictions.length + ' 处子句自相矛盾（既 ✅ 又「未修/挂账」）：'
        + hang.contradictions.slice(0, 3).join('；') + (hang.contradictions.length > 3 ? ' …' : '')
        + '　——多半是整段替换留下的残字，请清理。');
    }
    if (hang.issues.length === 0) {
      ok('核对记录挂账纪律：' + hang.rows + ' 行中 ' + hang.hangCount + ' 处「未修/挂账」子句均已带 ✅ 闭环标记');
    } else {
      bad('核对记录有 ' + hang.issues.length + ' 处「未修/挂账」子句既无 ✅ 闭环标记、也无在办说明：'
        + hang.issues.slice(0, 3).join('；') + (hang.issues.length > 3 ? ' …' : ''));
    }
  }
}


/* 18. 签批依据与台账现状的自相矛盾（2026-09-28）
 *
 * 起因：expert/20-docs 在 DSP-20260928-1530-01 抓出，AP-20260928-1228-01 的决策依据写着
 *   「已重跑 approval-sync / dispatch-metrics 刷新。**条件既已满足，故落批准**」
 * 而那两个脚本**根本不写待签批清单的状态列**，该行状态当时仍是「待签批」——条件并未满足。
 *   这是本体系第一次出现**写在人类签批台账上的不成立陈述**，且当时无人发现。
 *
 * ⚠ 本节的能力边界（不得在任何文档里夸大）：
 *   它查的是**机械可判定的矛盾**（断言 X 而台账证明非 X），**不是**核实依据为真。
 *   依据里绝大多数内容是无法机械验证的推理，那仍然只能靠人或专家评审。
 *   绿灯的含义是「**未发现矛盾**」，仅此而已；不得写成「审批依据已自动核实」。
 *
 * ⚠ 它**防再犯，不证过去**：1228-01 的状态列今天已回填，所以直接跑真实数据必然 0 命中。
 *   反向测试必须**把历史状态模拟回去**才能证明它当初抓得到（见 scripts/selftest.mjs）。
 */
{
  const [apTxt, qTxt] = await Promise.all([
    (async () => { try { return await rawReadFile(path.join(docDir, 'runbook', '审批记录.md'), 'utf8'); } catch { return null; } })(),
    (async () => { try { return await rawReadFile(path.join(docDir, 'runbook', '待签批清单.md'), 'utf8'); } catch { return null; } })(),
  ]);
  if (apTxt === null || qTxt === null) {
    bad('读不到审批记录.md 或 待签批清单.md（依据矛盾检查无从进行）');
  } else {
    const cellOf = (l) => l.split('|').slice(1, -1).map((x) => x.trim());
    const apRows = apTxt.split(/\r?\n/).filter((l) => l.startsWith('| AP-')).map(cellOf);
    const qRows = qTxt.split(/\r?\n/).filter((l) => l.startsWith('| AP-')).map(cellOf);
    const qHead = qTxt.split(/\r?\n/).find((l) => l.startsWith('| 审批单号') && l.indexOf('状态') >= 0);
    const iQ = qHead ? cellOf(qHead).findIndex((h) => h.indexOf('状态') >= 0) : -1;
    if (iQ < 0) bad('待签批清单表头里找不到「状态」列（依据矛盾检查无从进行）');
    const queueStatus = new Map(iQ >= 0 ? qRows.map((r) => [r[0], r[iQ] || '']) : []);

    // 键用**文件名**而非视图别名：`签批状态视图` 与 `状态视图` 是同一个文件的两个别名，
    // 按别名建键会让同一次过期被数成两条违规，计数虚高一倍。
    const viewDays = new Map();
    for (const file of VIEW_FILES) {
      let md = null;
      try { md = await rawReadFile(path.join(docDir, 'runbook', file), 'utf8'); } catch { md = null; }
      const d = md ? viewGeneratedAt(md) : null;
      if (d) viewDays.set(file, d);
    }

    // ⚠ 索引**按位置**取（审批记录列序：0单号 1日期 2签批时间 … 9结论 10依据 11会签 12证据），
    //   但**必须先自证表头列序**，否则改过列序就会静默读错列——本轮已因索引读错邻列
    //   得出过「0 处异常」这种假零。
    const apHead = apTxt.split(/\r?\n/).find((l) => l.startsWith('| 审批单号') && l.indexOf('决策依据') >= 0);
    const ah = apHead ? cellOf(apHead) : null;
    const iAp = ah ? ah.findIndex((h) => h.indexOf('审批单号') >= 0) : -1;
    const iSign = ah ? ah.findIndex((h) => h.indexOf('签批时间') >= 0) : -1;
    const iBasis = ah ? ah.findIndex((h) => h.indexOf('决策依据') >= 0) : -1;
    if (iAp < 0 || iSign < 0 || iBasis < 0) {
      bad('审批记录表头缺列（审批单号=' + iAp + ' 签批时间=' + iSign + ' 决策依据=' + iBasis + '），依据矛盾检查无从进行');
    } else {
      const approvals = apRows.map((r) => ({
        ap: r[iAp] || '', basis: r[iBasis] || '', signDay: String(r[iSign] || '').slice(0, 10),
      }));
      const audit = auditApprovalBasis({ approvals, queueStatus, viewDays });
      // **自证**：一行都没读到时，「0 处矛盾」是不可信的，直接红。
      if (audit.inspected <= 0 || audit.clausesScanned <= 0) {
        bad('签批依据矛盾检查：**一行/一子句都没读到**（inspected=' + audit.inspected
          + ' clauses=' + audit.clausesScanned + '），本节结论不可信');
      } else if (audit.violations.length === 0) {
        ok('签批依据与台账现状：' + audit.inspected + ' 行 / ' + audit.clausesScanned
          + ' 子句中未发现自相矛盾（**仅代表未发现矛盾，不代表依据已被核实**）');
      } else {
        bad('签批依据与台账现状有 ' + audit.violations.length + ' 处自相矛盾：'
          + audit.violations.slice(0, 3).map((v) => v.ap + '[' + v.rule + '] ' + v.detail).join('；')
          + (audit.violations.length > 3 ? ' …' : ''));
      }
    }
  }
}

/* 19. 重复派单：同一 commit 被反复排入待签批队列（2026-09-28，人类 A 立项）
 *
 * 为什么要有：2026-09-28 实测 commit `6e9416c5` 被派 **32 次**（17:48–22:54 每约 6 分钟一轮），
 *   并把同一个 commit 排了 **6 次**待签批——等于要人类把同一件事签 6 遍。**门禁当时全绿**：
 *   每一笔在结构上都是合法派单，没有任何检查会响。只修循环不统计，等于只堵了这一次。
 *
 * ⚠ 统计逻辑**不在本文件里**，而在 `lib/runbook.mjs` 的 `duplicateQueueStats`。
 *   初版内联在此，selftest 根本测不到它——由 expert/14-qa-governance 在
 *   `DSP-20260929-0047-01` 指出「统计逻辑未抽取为独立函数致测试盲区」。
 *   **判据逻辑必须住在可单测的地方**：写在门禁里就只能靠「整份门禁跑一遍」验证，
 *   那既慢又无法构造边界情形。
 *
 * 判据与阈值的来历见 `lib/runbook.mjs` 该函数的 JSDoc（实测分布 {0:2,1:30,2:9,3:1,6:1}，
 * 次高值 3 故取 4；代价是「3 次以内不告警」，已在 `06` 写明）。
 */
{
  const KNOWN_Q = {
    '6e9416c5': '2026-09-28 17:48–22:54 被派 32 次、入队 6 次（DSP-20260928-1748/1750/1755/1944/2210/2302-01）；'
      + '根因已定位并修（幂等终态判据），6 笔按「只签一轮、其余标作重复」处置完毕',
  };
  const Q_THRESHOLD = 4;
  const E19 = String();

  // 派单行：从已读入的 dispatchLogText 切出，并**按表头名**定位「事项摘要」与「需签批」两列。
  // 写死列索引的教训本轮又栽了一次：曾先写了一个 validate 里根本不存在的变量名，
  // 且差点再写死第 3 列——核对记录的列序已经坑过我两次（处置列 6 vs 7）。
  const dispRows19 = (() => {
    const src = String(dispatchLogText || E19);
    const rows = [];
    const head = src.split('\n').find((l) => l.startsWith('| 派单号') && l.indexOf('事项摘要') >= 0);
    if (!head) return rows;
    const h = head.split('|').slice(1, -1).map((x) => x.trim());
    const iSub = h.findIndex((x) => x.indexOf('事项摘要') >= 0);
    const iNeed = h.findIndex((x) => x.indexOf('需签批') >= 0);
    if (iSub < 0 || iNeed < 0) return rows;
    for (const l of src.split('\n')) {
      if (!l.startsWith('| DSP-')) continue;
      const r = l.split('|').slice(1, -1).map((x) => x.trim());
      rows.push([String(r[0] || E19), String(r[iSub] || E19), String(r[iNeed] || E19)]);
    }
    return rows;
  })();

  if (dispatchLogText && dispRows19.length === 0) {
    bad('重复派单检查：派单日志有内容但**切不出数据行**（表头或列名变了），本节结论不可信');
  } else if (dispRows19.length === 0) {
    bad('重复派单检查：**一行派单都没读到**，本节结论不可信');
  } else {
    const q19 = duplicateQueueStats(dispRows19, { threshold: Q_THRESHOLD, known: KNOWN_Q });
    // **自证**：入队标记一个都没解析出来时，「无重复」不可信——
    // 「解析器坏了」与「没有重复」会输出同一句话。
    // 本轮已栽过一次假零（变量名撞车导致每行 continue，却输出「0 处」）。
    if (q19.queuedMarks === 0) {
      bad('重复派单检查：入队标记（需签批=Y）**一个都没解析出来**，本节结论不可信');
    } else {
      const fresh = q19.over.filter((x) => x.fresh);
      const known = q19.over.filter((x) => !x.fresh);
      for (const x of known) log(`  ⚠ 已知旧账 ${x.hash}（入队 ${x.list.length} 次）：${x.why}`);
      // Top 计数作为信息行输出：让趋势可见，而不是只在越线时才说话
      const top = [...q19.total.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([h, n]) => `${h}×${n}`).join('、');
      if (fresh.length) {
        bad('重复入队告警：' + fresh.length + ' 个 commit 被排入待签批队列 ≥' + Q_THRESHOLD + ' 次：'
          + fresh.slice(0, 3).map((x) => `${x.hash}×${x.list.length}（${x.list.slice(0, 3).join('/')}${x.list.length > 3 ? '…' : E19}）`).join('；')
          + (fresh.length > 3 ? ' …' : E19)
          + '　——**同一份内容反复要人类签字**，而每一笔在结构上都是合法派单、门禁当时全绿。'
          + '查法：`git log --oneline -1 <hash>` 确认该 commit，再看 `logs/watcher.log` 找循环区间；'
          + '根因通常是「幂等跳过被 fail-closed 判成失败 → 不推进 lastHead → 下一轮又派」。'
          + `（总派单 Top3：${top}）`);
      } else {
        ok('重复入队：' + dispRows19.length + ' 行派单 / ' + q19.total.size + ' 个 commit / 入队标记 '
          + q19.queuedMarks + ' 处，无「同一 commit 入队 ≥' + Q_THRESHOLD + ' 次」'
          + (known.length ? `（另有 ${known.length} 个已知旧账已显式列出）` : E19)
          + `。总派单 Top3：${top}`);
      }
    }
  }
}

/* 20. 文档「可证伪断言」核对（2026-09-28，人类 A 立项；实现见 lib/doc-assert.mjs）
 *
 * 缺口来源：`06 §7.4` 记录过「文档正文里的事实断言无自动检查」。
 * 它在 2026-09-28 兑现了两次——`06 §7.1` 的 import 断言（DSP-20260928-1658-01）
 * 与 `04` 里 approval-sync 的写目标个数（DSP-20260928-1730-01），
 * **两次都不是靠检查发现的，是靠专家评审发现的**。
 *
 * 做法（形式化先于检查，这是 `06 §7.4` 自己写的次序）：
 *   文档里用行尾标记 `<!--核:<checkId>-->` 指向一个**登记在代码里**的检查；
 *   检查去**代码**里核对，**绝不拿文档自己证明文档自己**。
 *
 * 三条让它不至于变成「表演性标注」的性质（任一失效本节即失去意义）：
 *   1. 标记了但 checkId 未登记 → 报红（否则「标了」会被当成「查了」）；
 *   2. 登记了但文档里找不到标记 → 报红（否则重写文档后检查静默失效、仍然全绿）；
 *   3. 实跑比对的是代码里的事实（如 `await writeFile(` 出现几次），不是文档里的措辞。
 *
 * ⚠ 诚实的边界（不得夸大）：本节**只能核对被显式标记的断言**。
 *   没标记的文档断言**依然无人核对**。准确说法是「**把标注过的断言变成有门禁的断言**」，
 *   **不是**「文档已自动核实」。`06 §8.4` 那个缺口被缩小了，没有被消灭。
 */
{
  const docAudit = await auditDocAssertions(ROOT);
  // **自证**：一个标记都没扫到时，「全部通过」不可信——那意味着扫描器坏了或文档目录变了
  if (docAudit.filesScanned <= 0 || docAudit.marked <= 0) {
    bad('文档断言核对：**没扫到任何文件或任何标记**（files=' + docAudit.filesScanned
      + ' marked=' + docAudit.marked + '），本节结论不可信');
  } else if (docAudit.violations.length === 0) {
    ok('文档可证伪断言：' + docAudit.filesScanned + ' 个文档、' + docAudit.marked + ' 处标记 / '
      + docAudit.registered + ' 项登记，实跑 ' + docAudit.checked + ' 项全部一致'
      + '（**仅覆盖已标记的断言，不等于文档已核实**）');
  } else {
    bad('文档可证伪断言有 ' + docAudit.violations.length + ' 处问题：'
      + docAudit.violations.slice(0, 3).map((v) => `[${v.why}] ${v.id}：${v.detail}`).join('；')
      + (docAudit.violations.length > 3 ? ' …' : ''));
  }
}

/* 21. 台账「列形态」自证（2026-09-29，人类 A 立项；实现见 lib/col-shape.mjs）
 *
 * 补的是一类**所有现有门禁都抓不到**的错：`核对记录.md` 曾有 9 行**整格错位**——
 * 我把「可验证反证」与「差集说明」当成两列分别填，而表头第 6 列名叫
 * 「可验证反证 / 差集说明」，**斜杠就表示合并成一格**。于是差集挤进「处置」列、
 * 处置挤进「复核人」列、**复核人直接丢失**。
 *
 * **它为什么一路绿灯**：列数是对的（8 列仍是 8 列），所以 ledger-doctor 的列宽检查、
 * validate 的挂账纪律、seed --check 的占位符检查**全都抓不到**。
 * 错的不是列数，是**内容形态**。本节补的就是这一类。
 *
 * ⚠ 判据是「该列不该长什么样」（长度/标点/是否为空），**不是**「该列该长什么样子」的白名单。
 *   我第一版用白名单正则判处置列，39 行报 35 行，绝大多数是误报——`无需处置（批准）`、
 *   `同上` 都是合法处置却没匹配上。**黑名单式判定只能挡住预想到的形态**，
 *   这个问题我在别处反复批评过，结果自己在同一个钟点上又犯了一次。
 *
 * ⚠ 与第 17 节（挂账）、ledger-doctor（列宽）的分工：那两节判「有没有填、有没有对齐」，
 *   本节判「填进去的东西**是不是这一列该装的东西**」。三者不可互相替代。
 */
{
  const shapeAudit = await auditColumnShapes(ROOT);
  // **自证**：三件都不可为零。零行扫描或零格判定时，「0 处违规」不可信——
  // 「表读空了」与「全部合规」会输出同一句话。
  if (shapeAudit.filesRead <= 0 || shapeAudit.rowsScanned <= 0 || shapeAudit.cellsJudged <= 0) {
    bad('列形态自证：filesRead=' + shapeAudit.filesRead + ' rows=' + shapeAudit.rowsScanned
      + ' cells=' + shapeAudit.cellsJudged + '，**没比对到任何一格**，本节结论不可信');
  } else if (shapeAudit.violations.length === 0) {
    ok('列形态：' + shapeAudit.specsApplied + ' 项规格 / ' + shapeAudit.filesRead + ' 张表 / '
      + shapeAudit.rowsScanned + ' 行 / ' + shapeAudit.cellsJudged + ' 格，形态全部合规'
      + '（**只覆盖规格里列出的那几列**，不等于全表内容都对）');
  } else {
    bad('列形态不合 ' + shapeAudit.violations.length + ' 处：'
      + shapeAudit.violations.slice(0, 4).map((v) => `${v.id} 的「${v.col}」${v.detail}`).join('；')
      + (shapeAudit.violations.length > 4 ? ' …' : '')
      + '　——这类错列数是对的，靠列宽检查抓不到；处置见 lib/col-shape.mjs 的 JSDoc');
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
