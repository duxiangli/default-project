/**
 * 专家团体系一致性校验
 * 用法：node scripts/validate-expert-team.mjs
 * 校验：Agent 文件完整性/frontmatter/路由引用/岗位卡命名/RACI 双写一致/占位符规范
 */
import { readdir, readFile } from 'node:fs/promises';
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
  const c = await readFile(p, 'utf8');
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
const routerText = await readFile(path.join(agentsDir, 'router.md'), 'utf8');
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
  const c = await readFile(path.join(cardsDir, f), 'utf8');
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
const csv = await readFile('docs/expert-team/raci/RACI矩阵.csv', 'utf8');
const lines = csv.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
if (lines.length === 16) ok(`RACI CSV 1 表头 + 15 事项`);
else bad(`RACI CSV 行数应为 16，实际 ${lines.length}`);
const csvAreats = lines.slice(1).map((l) => {
  const cols = l.split(',');
  return cols[3] && !/Agent/i.test(cols[3]) ? cols[0] : null; // A 列不应是 Agent
}).filter(Boolean);
if (csvAreats.length === 15) ok('RACI CSV 每事项 A 列为人类，无 Agent 占 A');
else bad(`RACI CSV 有 ${15 - csvAreats.length} 行 A 列异常`);
const csvTodo = new Set(lines.slice(1).map((l) => l.split(',')[0]));

// ── 6. 03-跨域RACI.md 与 CSV 一致 ──
const raciDoc = await readFile(path.join(docDir, '03-跨域RACI.md'), 'utf8');
const raciLines = raciDoc.split('\n');
const headerIdx = raciLines.findIndex((l) => l.startsWith('| 事项 |') || l.startsWith('| 事项|'));
if (headerIdx === -1) bad('03-跨域RACI.md 未找到 RACI 分配表');
const tableRows = [];
for (let i = headerIdx + 1; i < raciLines.length; i++) {
  const l = raciLines[i];
  if (!l.startsWith('|')) break;
  const cols = l.split('|').map((x) => x.trim());
  if (cols[1] === '---' || cols[1] === 'A') continue;
  if (cols[1] === '') continue;
  tableRows.push(cols[1]);
}
const docMissing = [...tableRows].filter((t) => !csvTodo.has(t));
if (docMissing.length === 0 && tableRows.length === 15) ok('03-跨域RACI.md 与 RACI CSV 事项一致（15/15）');
else bad(`03 与 CSV 不一致或缺行: ${docMissing.join(',')}（解析到 ${tableRows.length} 行）`);

// ── 7. 占位符规范：OpenCode 内不得有 {公司}，docs 模板允许 ──
let stray = 0;
for (const f of [...routerText && [], ...expertFiles.map((f) => `expert/${f}`)]) {
  const c = f === 'router.md' ? routerText : await readFile(path.join(agentsDir, f), 'utf8');
  if (c.includes('{公司}')) { stray++; bad(`${f}: 残留 {公司}`); }
}
if (!stray) ok('OpenCode Agent 无 {公司} 字面量');

// ── 8. 首席名册一致性（单一事实源） ──
const rosterCsv = await readFile('docs/expert-team/roster/首席名册.csv', 'utf8');
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

const overviewText = await readFile('docs/expert-team/00-体系总览.md', 'utf8');
const rosterMiss = [];
for (let i = 1; i <= 20; i++) {
  const r = rosterMap.get(i);
  if (!r) { rosterMiss.push(`缺${i}`); continue; }
  const cardFile = (await readdir(cardsDir)).find((f) => f.startsWith(String(i).padStart(2, '0') + '-'));
  const card = await readFile(path.join(cardsDir, cardFile), 'utf8');
  const agent = await readFile(path.join(expertDir, expertFiles.find((f) => f.startsWith(String(i).padStart(2, '0') + '-'))), 'utf8');
  if (!card.includes(`${r.role} · ${r.name}`)) rosterMiss.push(`卡${i}缺姓名`);
  if (!agent.includes(`人类首席（${r.role} · ${r.name}）`)) rosterMiss.push(`Agent${i}缺姓名`);
  if (!routerText.includes(`${r.role} · ${r.name}`)) rosterMiss.push(`router缺${r.name}`);
  if (!overviewText.includes(`${r.role} · ${r.name}`)) rosterMiss.push(`00总览缺${r.name}`);
}
const readme = await readFile('README.md', 'utf8');
for (const r of rosterRows) {
  if (!readme.includes(`${r[2]} · ${r[3]}`)) rosterMiss.push(`README缺${r[3]}`);
}
if (rosterMiss.length === 0) ok('名册 ↔ 岗位卡 ↔ 专家Agent ↔ router ↔ 00总览/README 姓名一致（20/20）');
else bad(`名册传播不完整: ${rosterMiss.join('; ')}`);

// ── 9. MCP 接入样例：opencode.jsonc ↔ Agent 只读权限 ──
const mcpConfig = await readFile('.opencode/opencode.jsonc', 'utf8');
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
  const c = f === 'router.md' ? routerText : await readFile(path.join(agentsDir, f), 'utf8');
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
if (!routerText.includes('# 自主介入协议')) autoIssues.push('router 缺自主介入协议');
if (!routerText.includes('# 派单留痕')) autoIssues.push('router 缺派单留痕');
let dispatchLogText = '';
try { dispatchLogText = await readFile('docs/expert-team/runbook/派单日志.md', 'utf8'); } catch { autoIssues.push('缺 派单日志.md'); }
if (dispatchLogText && !dispatchLogText.includes('<!-- dispatch-log-end -->')) autoIssues.push('派单日志缺末尾标记');
try { await readFile('scripts/autodispatch-watcher.mjs', 'utf8'); } catch { autoIssues.push('缺 scripts/autodispatch-watcher.mjs'); }
if (autoIssues.length === 0) ok('自主派单：default_agent=router + 留痕写白名单 + 派单日志 + 事件驱动脚本就绪');
else bad(`自主派单配置不齐: ${autoIssues.join('; ')}`);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);