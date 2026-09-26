/**
 * 专家团体系一致性校验
 * 用法：node scripts/validate-expert-team.mjs
 * 校验：Agent 文件完整性/frontmatter/路由引用/岗位卡命名/RACI 双写一致/占位符规范
 */
import { readdir, readFile as rawReadFile } from 'node:fs/promises';

/** 统一归一化换行：CRLF 检出（Windows）下校验结果必须与 LF 检出（Linux CI）一致 */
const rd = async (p, enc = 'utf8') => (await rawReadFile(p, enc)).replace(/\r\n/g, '\n');
import path from 'node:path';

let pass = 0;
let fail = 0;
const ok = (msg) => { pass++; console.log(`  ✅ ${msg}`); };
const bad = (msg) => { fail++; console.log(`  ❌ ${msg}`); };

const agentsDir = '.opencode/agents';
const expertDir = path.join(agentsDir, 'expert');
const cardsDir = 'docs/expert-team/agent-cards';
const docDir = 'docs/expert-team';

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

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);