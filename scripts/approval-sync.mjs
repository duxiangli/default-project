/**
 * 签批闭环同步器：待签批清单 ⇄ 审批记录台账 → 生成签批状态视图
 *
 * 解决的断点：v1 体系里「人类在审批记录.md 签批」之后，router/脚本无从得知结果，
 * 待签批项只进不出，积压不可见、逾期不可查。本脚本做纯机械同步，不做任何签批决定。
 *
 * 产物：docs/expert-team/runbook/签批状态视图.md（自动生成，勿手改）
 * 用法：
 *   node scripts/approval-sync.mjs                 # 生成/刷新视图
 *   node scripts/approval-sync.mjs --strict        # 有超期或孤儿签批 → exit 1（CI 卡口）
 *   node scripts/approval-sync.mjs --check         # 只校验视图是否最新（CI 漂移检测）
 *   node scripts/approval-sync.mjs --require-closed # 额外要求零积压（发版前用）
 *   node scripts/approval-sync.mjs --stale-days 5  # 超期阈值（默认 3）
 *   node scripts/approval-sync.mjs --json          # 机器可读
 *
 * 边界：本脚本不写 审批记录.md（人类台账），不代替任何人类签字。
 */
import { writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRunbook, pendingRecords, approvalRecords, daysSince, RUNBOOK_FILES } from './lib/runbook.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VIEW_PATH = join(ROOT, 'docs', 'expert-team', 'runbook', RUNBOOK_FILES.view);

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const STALE_DAYS = Number(val('--stale-days', 3));

export function buildView(book, { staleDays = 3, generatedAt = new Date() } = {}) {
  const pendings = pendingRecords(book);
  const approvals = approvalRecords(book);
  const apIndex = new Map(approvals.filter((a) => a.ap).map((a) => [a.ap.id, a]));
  const pendingIds = new Set(pendings.map((p) => p.ap && p.ap.id).filter(Boolean));

  const open = [];
  const closed = [];
  for (const p of pendings) {
    const ap = p.ap ? apIndex.get(p.ap.id) : null;
    const ageDays = p.ap ? daysSince(p.ap.iso) : null;
    const record = { ...p, ageDays, closedBy: ap || null, stale: !ap && ageDays !== null && ageDays > staleDays };
    if (ap || !p.open) closed.push(record); else open.push(record);
  }
  const orphanApprovals = approvals.filter((a) => a.ap && !pendingIds.has(a.ap.id));

  const body = [];
  body.push('## 总览');
  body.push('');
  body.push('| 指标 | 值 |');
  body.push('| --- | --- |');
  body.push(`| 未闭环（待签批） | ${open.length} |`);
  body.push(`| 已闭环 | ${closed.length} |`);
  body.push(`| 超期（>${staleDays} 天未签批） | ${open.filter((o) => o.stale).length} |`);
  body.push(`| 孤儿签批（台账有、队列无） | ${orphanApprovals.length} |`);
  body.push(`| 最高风险未闭环 | ${open.some((o) => o.severity === '高') ? '高' : (open.some((o) => o.severity === '中') ? '中' : (open.length ? '低' : '—'))} |`);
  body.push('');
  body.push(`> 生成时间：${generatedAt.toISOString().replace('T', ' ').slice(0, 19)}　·　数据源：\`${RUNBOOK_FILES.pending}\` + \`${RUNBOOK_FILES.approval}\``);
  body.push('> 本文件由脚本生成，**勿手改**；签批仍只写 `' + RUNBOOK_FILES.approval + '`，重跑脚本即刷新。');
  body.push('');

  body.push('## 未闭环（待签批）');
  body.push('');
  if (!open.length) body.push('_无_');
  else {
    body.push('| 审批单号 | 事项摘要 | 人类A | 专家建议 | 严重度 | 账龄(天) | 状态 |');
    body.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const o of open.sort((a, b) => (b.ageDays ?? 0) - (a.ageDays ?? 0))) {
      body.push(`| ${o.ap ? o.ap.id : '—'} | ${o.subject} | ${o.humanA} | ${o.verdict || '—'} | ${o.severity || '—'} | ${o.ageDays ?? '—'}${o.stale ? ' ⚠超期' : ''} | ${o.status} |`);
    }
  }
  body.push('');

  body.push('## 已闭环');
  body.push('');
  if (!closed.length) body.push('_无_');
  else {
    body.push('| 审批单号 | 关联派单 | 事项摘要 | 签批结论 | 签批日期 |');
    body.push('| --- | --- | --- | --- | --- |');
    for (const c of closed) {
      body.push(`| ${c.ap ? c.ap.id : '—'} | ${c.dsp ? c.dsp.id : '—'} | ${c.subject} | ${(c.closedBy && c.closedBy.conclusion) || c.status} | ${(c.closedBy && c.closedBy.date) || '—'} |`);
    }
  }
  body.push('');

  if (orphanApprovals.length) {
    body.push('## ⚠ 孤儿签批（台账有记录、待签批队列无对应行）');
    body.push('');
    for (const a of orphanApprovals) body.push(`- ${a.ap.id}：${a.subject}（结论：${a.conclusion || '—'}）——需核对是补录还是队列漏登记`);
    body.push('');
  }
  return { text: body.join('\n'), open, closed, orphanApprovals };
}

const HEADER = `# 签批状态视图（自动生成，勿手编辑）

> 本视图是「待签批清单」与「审批记录台账」的机械镜像，用于未闭环跟踪与超期提醒。
`;

async function main() {
  const book = await readRunbook(ROOT);
  if (!book.pending.md || !book.approval.md) {
    console.error('缺少台账文件，无法同步');
    process.exit(2);
  }
  const { text, open, closed, orphanApprovals } = buildView(book, { staleDays: STALE_DAYS });
  const full = `${HEADER}\n${text}\n`;
  const bodyOnly = full.slice(HEADER.length);

  if (has('--json')) {
    console.log(JSON.stringify({
      open: open.length, closed: closed.length,
      stale: open.filter((o) => o.stale).map((o) => ({ ap: o.ap && o.ap.id, days: o.ageDays, subject: o.subject })),
      orphans: orphanApprovals.map((a) => a.ap && a.ap.id),
    }, null, 2));
  }

  if (has('--check')) {
    // 只比对「非时间派生」的不变量：未闭环/已闭环的单号集合与孤儿单号。
    // 账龄、超期、生成时间每天自然变化，若纳入比对会让 CI 永久变红。
    const fingerprint = (openList, closedList, orphans) => JSON.stringify({
      open: openList.map((o) => o.ap && o.ap.id).filter(Boolean).sort(),
      closed: closedList.map((c) => c.ap && c.ap.id).filter(Boolean).sort(),
      orphans: orphans.map((a) => a.ap && a.ap.id).filter(Boolean).sort(),
    });
    const want = fingerprint(open, closed, orphanApprovals);
    const cur = book.view.md || '';
    const grab = (heading) => {
      const seg = cur.split(`## ${heading}`)[1] || '';
      const body = seg.split(/\n## /)[0]; // 必须截到下一个章节，否则会把后续表格也算进来
      return [...body.matchAll(/\|\s*(AP-\d{8}-\d{4}(?:-\d{2})?)\s*\|/g)].map((m) => m[1]);
    };
    const got = JSON.stringify({ open: grab('未闭环（待签批）').sort(), closed: grab('已闭环').sort(), orphans: grab('⚠ 孤儿签批') });
    if (cur && got === want) { console.log('签批状态视图：结构最新 ✓（未闭环/已闭环/孤儿 与台账一致）'); return; }
    console.error('签批状态视图：已过期或与台账不一致，请运行 node scripts/approval-sync.mjs');
    process.exit(1);
  }

  await writeFile(VIEW_PATH, full, 'utf8');
  const staleN = open.filter((o) => o.stale).length;
  console.log(`签批状态视图已刷新：未闭环 ${open.length}、已闭环 ${closed.length}、超期 ${staleN}、孤儿签批 ${orphanApprovals.length}`);
  console.log(`  → ${VIEW_PATH}`);
  if (has('--strict') || has('--require-closed')) {
    const violations = [];
    if (staleN > 0) violations.push(`超期未签批 ${staleN} 项`);
    if (orphanApprovals.length > 0) violations.push(`孤儿签批 ${orphanApprovals.length} 项`);
    if (has('--require-closed') && open.length > 0) violations.push(`未闭环 ${open.length} 项`);
    if (violations.length) {
      console.error(`门禁未过：${violations.join('、')}`);
      console.error('  （未闭环本身不算违规——等人类签批是流程常态；用 --require-closed 才强制零积压）');
      process.exit(1);
    }
    console.log('门禁通过：无超期、无孤儿签批' + (has('--require-closed') ? '、零积压' : ''));
  }
}
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  main().catch((e) => { console.error(e.message || e); process.exit(1); });
}
