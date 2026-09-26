/**
 * 度量看板生成器：从派单日志/待签批清单/审批记录机械计算体系健康度
 *
 * 补的洞：05-落地清单与度量的 KPI 表里，多数「数据来源」写的是「审计库/告警/抽样审计」，
 * 实际无法从仓库文件算出，导致度量长期空转。本脚本只算「能从台账机械得出」的那部分，
 * 算不出的（误报率、漏审率、越权尝试）明确标注为需人工/需工具侧采集，不假装有数。
 *
 * 产物：docs/expert-team/runbook/度量看板.md（自动生成，勿手改）
 * 用法：node scripts/dispatch-metrics.mjs [--check] [--json] [--days 30]
 */
import { writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRunbook, dispatchRecords, pendingRecords, approvalRecords, daysSince, RUNBOOK_FILES } from './lib/runbook.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs', 'expert-team', 'runbook', RUNBOOK_FILES.metrics);
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : '—');
const tally = (arr) => arr.reduce((m, x) => (x ? { ...m, [x]: (m[x] || 0) + 1 } : m), {});
const topN = (obj, n = 8) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n);

const GATE_WORDS = ['门禁', '合规', '等保', '个保', '回滚', '凭据', '密钥', '注入', 'SLO', '资损'];

export function computeMetrics(book, { days = 30 } = {}) {
  const dispatches = dispatchRecords(book);
  const pendings = pendingRecords(book);
  const approvals = approvalRecords(book);
  const apIndex = new Map(approvals.filter((a) => a.ap).map((a) => [a.ap.id, a]));
  const since = Date.now() - days * 86400000;
  const inWindow = (iso) => { const t = new Date(String(iso).replace(' ', 'T')).getTime(); return Number.isFinite(t) && t >= since; };

  const total = dispatches.length;
  const needSign = dispatches.filter((d) => d.needSign === 'Y');
  const verdicts = tally(dispatches.map((d) => d.verdict));
  const severities = tally(dispatches.map((d) => d.severity));
  const experts = tally(dispatches.flatMap((d) => `${d.dispatched} ${d.R} ${d.C}`.match(/expert\/[a-z0-9-]+/g) || []).map((s) => s.replace('expert/', '')));
  const humans = tally(dispatches.map((d) => d.humanA.split('·')[0].trim()).filter(Boolean));

  // 签批闭环：采纳率对「已闭环且两侧四态可解析」的项统计。
  // 只按四态字符串相等判定会把「专家驳回 → 人类有条件批准」误算为未采纳，故分三类：
  //   一致采纳（四态相同）｜条件采纳（结论不同但审批依据含条件/整改）｜偏离（结论不同且无条件）
  const closedPairs = pendings.filter((p) => p.ap && apIndex.has(p.ap.id));
  const comparable = closedPairs.filter((p) => p.verdict && apIndex.get(p.ap.id).conclusion);
  const adoptClass = (p) => {
    const a = apIndex.get(p.ap.id);
    if (p.verdict === a.conclusion) return '一致采纳';
    return /条件|整改|复跑|验证|留档|后关闭|转「?批准/.test(a.basis || '') ? '条件采纳' : '偏离';
  };
  const adoptTally = tally(comparable.map(adoptClass));
  const adopted = (adoptTally['一致采纳'] || 0) + (adoptTally['条件采纳'] || 0);
  const cycleDays = closedPairs
    .map((p) => {
      const a = apIndex.get(p.ap.id);
      if (!p.ap) return null;
      // 优先用「签批时间(精确到分)」；缺失时回退到审批日期（日粒度）
      const stamp = (a.signedAt && a.signedAt.includes(':')) ? a.signedAt : (a.date ? a.date.replace(/-/g, '/') : null);
      if (!stamp) return null;
      const t1 = new Date(String(stamp).replace(/-/g, '/')).getTime();
      const t0 = new Date(p.ap.iso.replace(' ', 'T')).getTime();
      return Number.isFinite(t1) && Number.isFinite(t0) ? (t1 - t0) / 86400000 : null;
    })
    .filter((x) => x !== null);

  const open = pendings.filter((p) => p.open);
  const openAges = open.map((p) => (p.ap ? daysSince(p.ap.iso) : null)).filter((x) => x !== null);
  const gateHits = dispatches.filter((d) => GATE_WORDS.some((w) => `${d.subject} ${d.raw}`.includes(w)));
  const windowDispatches = dispatches.filter((d) => d.dsp && inWindow(d.dsp.iso));

  return {
    total, needSign: needSign.length, needSignRate: pct(needSign.length, total),
    verdicts, severities, experts, humans,
    windowDays: days, windowDispatches: windowDispatches.length,
    open: open.length,
    maxOpenAge: openAges.length ? Math.max(...openAges) : null,
    avgOpenAge: openAges.length ? (openAges.reduce((a, b) => a + b, 0) / openAges.length).toFixed(1) : null,
    adoptRate: pct(adopted, comparable.length), adopted, comparable: comparable.length,
    adoptClass: adoptTally,
    avgCycleDays: cycleDays.length ? (cycleDays.reduce((a, b) => a + b, 0) / cycleDays.length).toFixed(1) : null,
    gateHitRate: pct(gateHits.length, total),
    dataQuality: {
      serialParseable: pct(dispatches.filter((d) => d.dsp).length, total),
      verdictParseable: pct(dispatches.filter((d) => d.verdict).length, total),
      needSignParseable: pct(dispatches.filter((d) => d.needSign).length, total),
    },
  };
}

export function renderDashboard(m) {
  const L = [];
  L.push(`> 由 \`node scripts/dispatch-metrics.mjs\` 生成；口径见 05-落地清单与度量.md。机械计算项与「需人工采集」项已分开标注。`);
  L.push('');
  L.push('## 1. 派单吞吐');
  L.push('');
  L.push('| 指标 | 值 |');
  L.push('| --- | --- |');
  L.push(`| 派单总量（累计） | ${m.total} |`);
  L.push(`| 需签批条目 | ${m.needSign}（占 ${m.needSignRate}） |`);
  L.push(`| 近 ${m.windowDays} 天派单 | ${m.windowDispatches} |`);
  L.push(`| 门禁/合规类结论命中 | ${m.gateHitRate} |`);
  L.push('');
  L.push('## 2. 结论四态分布（专家建议）');
  L.push('');
  L.push(`| 批准 | 有条件 | 驳回 | 需人工 | 不可解析 |`);
  L.push('| --- | --- | --- | --- | --- |');
  L.push(`| ${m.verdicts['批准'] || 0} | ${m.verdicts['有条件'] || 0} | ${m.verdicts['驳回'] || 0} | ${m.verdicts['需人工'] || 0} | ${m.total - Object.values(m.verdicts).reduce((a, b) => a + b, 0)} |`);
  L.push('');
  L.push('## 3. 严重度分布');
  L.push('');
  L.push(`| 高 | 中 | 低 | 未标注 |`);
  L.push('| --- | --- | --- | --- |');
  L.push(`| ${m.severities['高'] || 0} | ${m.severities['中'] || 0} | ${m.severities['低'] || 0} | ${m.total - Object.values(m.severities).reduce((a, b) => a + b, 0)} |`);
  L.push('');
  L.push('## 4. 签批闭环');
  L.push('');
  L.push('| 指标 | 值 |');
  L.push('| --- | --- |');
  L.push(`| 未闭环（待签批） | ${m.open} |`);
  L.push(`| 最长账龄（天） | ${m.maxOpenAge ?? '—'} |`);
  L.push(`| 平均账龄（天） | ${m.avgOpenAge ?? '—'} |`);
  L.push(`| 建议采纳率（一致+条件采纳） | ${m.adoptRate}（${m.adopted}/${m.comparable}） |`);
  L.push(`| ├ 一致采纳（四态相同） | ${m.adoptClass['一致采纳'] || 0} |`);
  L.push(`| ├ 条件采纳（结论不同但带条件） | ${m.adoptClass['条件采纳'] || 0} |`);
  L.push(`| └ 偏离（结论不同且无条件） | ${m.adoptClass['偏离'] || 0} |`);
  L.push(`| 平均签批闭环时长（天） | ${m.avgCycleDays ?? '—'} |`);
  L.push('');
  L.push('## 5. 专家参与频次');
  L.push('');
  L.push('| 专家 | 参与次数 |');
  L.push('| --- | --- |');
  for (const [k, v] of topN(m.experts)) L.push(`| ${k} | ${v} |`);
  L.push('');
  L.push('## 6. 台账数据质量');
  L.push('');
  L.push('| 单号可解析 | 四态可解析 | 需签批标记可解析 |');
  L.push('| --- | --- | --- |');
  L.push(`| ${m.dataQuality.serialParseable} | ${m.dataQuality.verdictParseable} | ${m.dataQuality.needSignParseable} |`);
  L.push('');
  L.push('## 7. 仍需人工/工具侧采集（本脚本不假装能算）');
  L.push('');
  L.push('- **误报率**：需各域报告闭环后人工判定「是否真需处置」；');
  L.push('- **漏审率**：需抽样审计（人工抽检 diff × 是否本应拦截）；');
  L.push('- **越权尝试次数**：需 OpenCode 服务侧工具调用审计日志（本仓库无该数据源）；');
  L.push('- **门禁阻塞根因分布**：需 7 道门禁各自的结构化记录（当前只在结论散文里）。');
  return L.join('\n');
}

const HEADER = `# 度量看板（自动生成，勿手编辑）\n\n`;

async function main() {
  const book = await readRunbook(ROOT);
  const m = computeMetrics(book, { days: Number(val('--days', 30)) });
  const body = `${HEADER}${renderDashboard(m)}\n`;

  if (has('--json')) { console.log(JSON.stringify(m, null, 2)); if (has('--check')) return; }
  if (has('--check')) {
    // 只比非时间派生项：派单总量/需签批/四态/严重度/采纳率/数据质量。
    // 「近 N 天」与积压账龄随时间自然变化，纳入比对会让 CI 永久变红。
    const pick = (s) => (String(s).match(/^\| (派单总量（累计）|需签批条目|\d+ \| \d+ \| \d+ \| \d+ \| \d+ \||\d+ \| \d+ \| \d+ \| \d+ \|.*|采纳率.*|\d+% \| \d+% \| \d+% \|).*$/gm) || []).join('\n');
    const cur = book.metrics.md || '';
    if (cur && pick(cur) === pick(body)) { console.log('度量看板：结构最新 ✓（总量/四态/严重度/采纳率/数据质量 与台账一致）'); return; }
    console.error('度量看板：已过期或与台账不一致，请运行 node scripts/dispatch-metrics.mjs');
    process.exit(1);
  }
  await writeFile(OUT, body, 'utf8');
  console.log(`度量看板已刷新：派单 ${m.total}、需签批 ${m.needSign}、未闭环 ${m.open}、采纳率 ${m.adoptRate}`);
  console.log(`  → ${OUT}`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  main().catch((e) => { console.error(e.message || e); process.exit(1); });
}
