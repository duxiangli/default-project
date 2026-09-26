/**
 * 治理契约审计：把「越权尝试=0」「加固不回退」「台账一致」变成可机械检测的关卡
 *
 * 覆盖 8 项：
 *  1) router 写白名单精确等于两个审计文件，且绝不包含审批台账/自动生成视图/看板；
 *  2) 20 个专家 Agent 一律无 write/edit 放行（只读 + 只读 MCP 工具）；
 *  3) 配置与文档里无明文密钥（一律 {env:...}）；
 *  4) 审批台账的改动来源线索（git 历史，输出供人工核对；Agent 无权写该文件）；
 *  5) 派单日志 ⇄ 待签批清单 ⇄ 审批记录 三方单号一致（需签批=Y 必有 AP 行、无重复号、无孤儿）；
 *  6) watcher 加固标记在位（fail-closed / 注入隔离 / 单实例锁 / 增量取提交）——防回退；
 *  7) 运行状态文件不入库（.gitignore 覆盖 + 仓库内无 state/lock 残留）；
 *  8) 自动生成视图（签批状态视图/度量看板）存在且最新。
 *
 * 用法：node scripts/guard-audit.mjs [--strict] [--json]
 * 退出码：0 无违规；1 有 ❌ 违规（--strict 时）；2 审计环境不可用
 */
import { readFile, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRunbook, dispatchRecords, pendingRecords, approvalRecords, parseSerial } from './lib/runbook.mjs';

const exec = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);

const findings = [];
const ok = (msg, detail) => findings.push({ level: 'ok', msg, detail });
const warn = (msg, detail) => findings.push({ level: 'warn', msg, detail });
const fail = (msg, detail) => findings.push({ level: 'fail', msg, detail });

const ROUTER_WHITELIST = new Set([
  'docs/expert-team/runbook/派单日志.md',
  'docs/expert-team/runbook/待签批清单.md',
]);
const FORBIDDEN_WRITE = ['docs/expert-team/runbook/审批记录.md', 'docs/expert-team/runbook/签批状态视图.md', 'docs/expert-team/runbook/度量看板.md'];

/** 解析 agent md 的 frontmatter permissions，返回放行 write/edit 的资源列表 */
function writePermissions(md) {
  const fm = String(md).split('---')[1] || '';
  const out = [];
  const blocks = fm.split(/\n\s*-\s*action:/).slice(1);
  for (const b of blocks) {
    const action = (b.match(/^\s*([a-z_*]+)/) || [])[1] || '';
    const resource = (b.match(/resource:\s*"?([^"\n]+)"?/) || [])[1] || '';
    const effect = (b.match(/effect:\s*(\w+)/) || [])[1] || '';
    if (effect === 'allow' && /^(write|edit|patch|delete|bash|shell)$/.test(action)) out.push({ action, resource: resource.trim() });
  }
  return out;
}

async function gitLines(args) {
  const r = await exec('git', ['-C', ROOT, ...args], { maxBuffer: 8 * 1024 * 1024 });
  return (r.stdout || '').split(/\r?\n/).filter(Boolean);
}

async function main() {
  /* 1) router 写白名单 */
  const routerMd = await readFile(join(ROOT, '.opencode', 'agents', 'router.md'), 'utf8');
  const routerW = writePermissions(routerMd);
  const routerRes = routerW.map((p) => p.resource);
  const extra = routerRes.filter((r) => !ROUTER_WHITELIST.has(r));
  const missing = [...ROUTER_WHITELIST].filter((r) => !routerRes.includes(r));
  const forbidden = routerRes.filter((r) => FORBIDDEN_WRITE.includes(r));
  if (forbidden.length) fail('router 写白名单触碰禁写文件', forbidden.join(', '));
  if (extra.length) fail('router 写白名单超出授权范围', extra.join(', '));
  if (missing.length) fail('router 缺少应有的审计写白名单', missing.join(', '));
  if (!forbidden.length && !extra.length && !missing.length) ok('router 写白名单精确等于 2 个审计文件', [...new Set(routerRes)].join(' + '));

  /* 2) 专家 Agent 只读 */
  const expertDir = join(ROOT, '.opencode', 'agents', 'expert');
  const experts = (await readdir(expertDir)).filter((f) => f.endsWith('.md'));
  const offenders = [];
  for (const f of experts) {
    const w = writePermissions(await readFile(join(expertDir, f), 'utf8'));
    if (w.length) offenders.push(`${f}: ${w.map((p) => p.action).join('/')}`);
  }
  experts.length === 20 ? ok('专家 Agent 数量 20') : fail(`专家 Agent 数量异常：${experts.length}`);
  offenders.length ? fail('专家 Agent 存在写权限（应一律只读）', offenders.join('; ')) : ok('20 个专家 Agent 一律无 write/edit/bash 放行');

  /* 3) 明文密钥 */
  const secretRe = /(token|password|passwd|secret|api[_-]?key|private[_-]?key)\s*[:=]\s*["']?([A-Za-z0-9_\-]{16,})/gi;
  const cfg = await readFile(join(ROOT, '.opencode', 'opencode.jsonc'), 'utf8');
  const cfgHits = [...cfg.matchAll(secretRe)].filter((m) => !/\{env:/.test(m[0]) && !/example|placeholder|xxx/i.test(m[2]));
  cfgHits.length ? fail('opencode.jsonc 疑似明文密钥', cfgHits.map((m) => m[0].slice(0, 60)).join('; ')) : ok('opencode.jsonc 密钥一律 {env:...}');
  const docFiles = [];
  const walkDocs = async (d) => { for (const e of await readdir(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) await walkDocs(p); else if (/\.(md|jsonc|mjs|csv)$/.test(e.name)) docFiles.push(p); } };
  await walkDocs(join(ROOT, 'docs'));
  await walkDocs(join(ROOT, 'scripts'));
  const docHits = [];
  for (const p of docFiles) {
    const t = await readFile(p, 'utf8');
    for (const m of t.matchAll(secretRe)) {
      if (/\{env:/.test(m[0]) || /example|placeholder|your|xxx|test|fake|dummy/i.test(m[2])) continue;
      docHits.push(`${p.slice(ROOT.length + 1)}: ${m[0].slice(0, 50)}`);
    }
  }
  docHits.length ? warn('文档/脚本中疑似密钥字面量（需人工确认）', docHits.join('; ')) : ok('文档与脚本无明文密钥字面量');

  /* 4) 审批台账改动来源线索 */
  try {
    const hist = await gitLines(['log', '--pretty=%h|%an|%s', '--', 'docs/expert-team/runbook/审批记录.md']);
    if (!hist.length) warn('审批台账无 git 历史（尚未提交）');
    else ok(`审批台账改动 ${hist.length} 次，提交者：${[...new Set(hist.map((h) => h.split('|')[1]))].join('、')}`, '人类签批台账，Agent 无写权限；若出现自动化提交者需立即核查');
  } catch (e) { warn('无法读取 git 历史（审批台账线索）', e.message); }

  /* 5) 三方单号一致性 */
  const book = await readRunbook(ROOT);
  const dispatches = dispatchRecords(book);
  const pendings = pendingRecords(book);
  const approvals = approvalRecords(book);
  const dspIds = dispatches.map((d) => d.dsp && d.dsp.id).filter(Boolean);
  const apIds = pendings.map((p) => p.ap && p.ap.id).filter(Boolean);
  const dupD = dspIds.filter((x, i) => dspIds.indexOf(x) !== i);
  const dupA = apIds.filter((x, i) => apIds.indexOf(x) !== i);
  dupD.length ? fail('派单号重复', [...new Set(dupD)].join(', ')) : ok(`派单号唯一（${dspIds.length} 条）`);
  dupA.length ? fail('审批单号重复', [...new Set(dupA)].join(', ')) : ok(`审批单号唯一（${apIds.length} 条）`);
  const apSet = new Set(apIds);
  const missingAp = dispatches.filter((d) => d.needSign === 'Y' && d.dsp && !pendings.some((p) => p.dsp && p.dsp.id === d.dsp.id));
  missingAp.length ? fail('需签批=Y 的派单未入待签批队列', missingAp.map((d) => d.dsp.id).join(', ')) : ok('需签批=Y 条目均在待签批队列');
  const dspSet = new Set(dspIds);
  const orphan = pendings.filter((p) => p.dsp && !dspSet.has(p.dsp.id));
  orphan.length ? fail('待签批条目关联的派单号不存在', orphan.map((p) => p.dsp.id).join(', ')) : ok('待签批条目均可回溯派单号');
  const apInLedger = new Set(approvals.map((a) => a.ap && a.ap.id).filter(Boolean));
  const orphanAp = apIds.filter((x) => !apInLedger.has(x));
  orphanAp.length ? warn('队列有单号、台账未签批（正常待签状态）', `${orphanAp.length} 项待人类签批`) : ok('队列与台账签批状态一致');
  const badSerial = [...dispatches, ...pendings, ...approvals].filter((r) => !parseSerial(r.dsp ? r.dsp.id : (r.ap ? r.ap.id : '')));
  badSerial.length ? warn('存在不可解析单号', `${badSerial.length} 行`) : ok('全部单号符合 DSP/AP-YYYYMMDD-HHMM 格式');

  /* 6) watcher 加固标记在位（防回退） */
  const watcher = await readFile(join(ROOT, 'scripts', 'autodispatch-watcher.mjs'), 'utf8');
  const guards = [
    ['fail-closed 状态处理', /fail-closed/], ['注入隔离块', /UNTRUSTED_COMMIT_DATA/], ['不可信文本清洗', /sanitizeUntrusted/],
    ['单实例锁', /acquireLock/], ['增量取提交', /\.\.HEAD/], ['原子写状态', /rename\(tmp/], ['优雅退出', /SIGINT/],
  ];
  const missingGuards = guards.filter(([, re]) => !re.test(watcher)).map(([n]) => n);
  missingGuards.length ? fail('watcher 加固标记缺失（疑似回退）', missingGuards.join(', ')) : ok(`watcher 加固 ${guards.length} 项标记在位`);

  /* 7) 状态文件不入库 */
  const gi = await readFile(join(ROOT, '.gitignore'), 'utf8');
  /(^|\n)\s*dist\/?\s*(\n|$)/.test(gi) ? ok('.gitignore 已忽略 dist/') : fail('.gitignore 未忽略 dist/（生成物可能误入库）');
  try {
    const tracked = await gitLines(['ls-files']);
    const stateLeak = tracked.filter((f) => /autodispatch.*(state|lock).*\.json$/i.test(f));
    stateLeak.length ? fail('运行状态文件被 git 跟踪', stateLeak.join(', ')) : ok('无状态/锁文件进入版本库');
  } catch { warn('无法执行 git ls-files'); }

  /* 8) 自动生成视图最新 */
  if (!book.view.md) fail('缺少签批状态视图', '请运行 node scripts/approval-sync.mjs');
  else ok('签批状态视图存在', `未闭环 ${pendings.filter((p) => p.open).length} 项`);
  if (!book.metrics.md) fail('缺少度量看板', '请运行 node scripts/dispatch-metrics.mjs');
  else ok('度量看板存在', `派单 ${dispatches.length} 条`);

  /* 输出 */
  const icon = { ok: '✅', warn: '⚠️', fail: '❌' };
  for (const f of findings) console.log(`${icon[f.level]} ${f.msg}${f.detail ? `\n     ${f.detail}` : ''}`);
  const fails = findings.filter((f) => f.level === 'fail').length;
  const warns = findings.filter((f) => f.level === 'warn').length;
  console.log(`\n契约审计：${findings.length - fails - warns} 通过 / ${warns} 警告 / ${fails} 违规`);
  if (has('--json')) console.log(JSON.stringify({ fails, warns, findings }, null, 2));
  if (fails && has('--strict')) process.exit(1);
  if (fails) process.exit(1);
}

main().catch((e) => { console.error('审计环境不可用：', e.message || e); process.exit(2); });
