/**
 * 签批闭环同步器：待签批清单 ⇄ 审批记录台账 → 生成签批状态视图 + 回填队列状态列
 *
 * 解决的断点：v1 体系里「人类在审批记录.md 签批」之后，router/脚本无从得知结果，
 * 待签批项只进不出，积压不可见、逾期不可查。本脚本做纯机械同步，不做任何签批决定。
 *
 * 产物：
 *   docs/expert-team/runbook/签批状态视图.md（自动生成，勿手改）
 *   docs/expert-team/runbook/待签批清单.md  的**状态列**（就地回填，见下）
 *
 * 用法：
 *   node scripts/approval-sync.mjs                 # 生成/刷新视图 + 回填状态列
 *   node scripts/approval-sync.mjs --strict        # 有超期或孤儿签批 → exit 1（CI 卡口）
 *   node scripts/approval-sync.mjs --check         # 只校验视图与状态列是否最新（CI 漂移检测）
 *   node scripts/approval-sync.mjs --no-pending-status  # 只刷视图，不动待签批清单
 *   node scripts/approval-sync.mjs --require-closed # 额外要求零积压（发版前用）
 *   node scripts/approval-sync.mjs --stale-days 5  # 超期阈值（默认 3）
 *   node scripts/approval-sync.mjs --json          # 机器可读
 *
 * ── 为什么现在才写状态列（2026-09-28）────────────────────────────────────
 * 状态列以前**纯靠人工回填**，而本脚本从来只 `readRunbook` 读它、写目标只有视图。
 * 代价实测过两次：
 *   ① `AP-20260928-1228-01` 的决策依据写「已重跑 approval-sync/dispatch-metrics 刷新，
 *      **条件既已满足**」——而这两个脚本**根本不写状态列**，条件并未满足。
 *      那句不成立的话当时就在**人类签批台账**上，直到 expert/20-docs 在
 *      `DSP-20260928-1530-01` 里抓出来。
 *   ② 于是每次签批都多一道纯抄写的人工步骤，抄漏了没有任何检查会响。
 *
 * ── 边界（务必守住）──────────────────────────────────────────────────────
 * · **本脚本不做任何签批决定。** 结论与日期的**唯一权威来源是人类写的审批记录台账**，
 *   这里只做「把人类已经写下的东西抄到队列状态列上」这一件机械事。
 * · **不写 审批记录.md**（人类台账），不代替任何人类签字。
 * · **problem 一律硬失败**（`problemGate`）：关联派单号错配、结论取值不可用、
 *   同一单号多行——这些一律**不抄并 exit 1**。宁可红，也不要一次静默的部分回填：
 *   部分回填比不回填更坏，因为台账看起来是处理过的。
 */
import { writeFile, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRunbook, pendingRecords, approvalRecords, daysSince, RUNBOOK_FILES } from './lib/runbook.mjs';
import { planPendingStatus, applyPendingStatus } from './lib/pending-status.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VIEW_PATH = join(ROOT, 'docs', 'expert-team', 'runbook', RUNBOOK_FILES.view);
const PENDING_PATH = join(ROOT, 'docs', 'expert-team', 'runbook', RUNBOOK_FILES.pending);

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
  void bodyOnly;

  // ── 状态列派生（纯读，不写）──────────────────────────────────────────
  // 审批单号 → { rawConclusion, date, dspId }。**结论取原始单元格文本**（人类写的那个），
  // 而不是 classifyVerdict 归一后的四态——归一会把「有条件批准」压成「有条件」，
  // 于是每次跑都把已写好的状态列改写一遍，噪声很大。
  const approvalByAp = new Map(approvalRecords(book)
    .filter((a) => a.ap)
    .map((a) => [a.ap.id, { rawConclusion: book.approvalTable.rows[a.line - 1][9] || '', date: a.date, dspId: a.dsp ? a.dsp.id : null }]));

  const touchPending = !has('--no-pending-status');
  const plan = planPendingStatus(book.pendingTable, approvalByAp);

  /** problem 硬失败闸门：一条都不许吞 */
  const problemGate = () => {
    if (!plan.problems.length) return;
    console.error(`待签批清单状态列：${plan.problems.length} 处**拒绝回填**（本脚本不猜）：`);
    for (const p of plan.problems) console.error(`  ${p.ap || '(整表)'}：${p.why}`);
    console.error('  → 请人工核对审批台账与待签批清单；修好后再跑。**不做部分回填**，'
      + '因为部分回填比不回填更坏：台账看起来是处理过的。');
    process.exit(1);
  };

  if (has('--json')) {
    console.log(JSON.stringify({
      open: open.length, closed: closed.length,
      stale: open.filter((o) => o.stale).map((o) => ({ ap: o.ap && o.ap.id, days: o.ageDays, subject: o.subject })),
      orphans: orphanApprovals.map((a) => a.ap && a.ap.id),
      pendingStatus: { inspected: plan.inspected, changes: plan.changes.length, problems: plan.problems.length },
    }, null, 2));
  }

  if (has('--check')) {
    // ① 视图：只比对「非时间派生」的不变量——未闭环/已闭环的单号集合与孤儿单号。
    //    账龄、超期、生成时间每天自然变化，若纳入比对会让 CI 永久变红。
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
    const viewOk = cur && got === want;
    if (!viewOk) console.error('签批状态视图：已过期或与台账不一致，请运行 node scripts/approval-sync.mjs');

    // ② 状态列：只要还有「台账已签批、队列仍写待签批」的行就是漂移。
    //    自证：必须真的检查过行，否则「0 处待回填」与「根本没检查」无法区分——
    //    这个坑本轮已经踩过一次（变量名撞车导致 Map 按单号首字符建索引，每行都 continue）。
    if (plan.inspected <= 0) {
      console.error('待签批清单状态列：**一行都没检查到**，本节的「无待回填」不可信，拒绝放行');
      process.exit(1);
    }
    const statusOk = !plan.changes.length;
    if (!statusOk) {
      console.error(`待签批清单状态列：${plan.changes.length} 行已签批但仍写「待签批」，请运行 node scripts/approval-sync.mjs`);
      for (const c of plan.changes.slice(0, 10)) console.error(`  ${c.ap}：${c.from} → ${c.to}`);
    }
    problemGate();
    if (viewOk && statusOk) {
      console.log(`签批闭环同步：结构最新 ✓（未闭环/已闭环/孤儿 与台账一致；状态列已核对 ${plan.inspected} 行，无待回填）`);
      return;
    }
    process.exit(1);
  }

  problemGate();
  await writeFile(VIEW_PATH, full, 'utf8');
  const staleN = open.filter((o) => o.stale).length;
  console.log(`签批状态视图已刷新：未闭环 ${open.length}、已闭环 ${closed.length}、超期 ${staleN}、孤儿签批 ${orphanApprovals.length}`);
  console.log(`  → ${VIEW_PATH}`);

  // ── 状态列回填（就地改一格，不新增/删除/重排行）────────────────────────
  if (touchPending) {
    if (plan.changes.length) {
      const src = await readFile(PENDING_PATH, 'utf8');
      const { md, applied } = applyPendingStatus(src, book.pendingTable, plan.changes);
      if (applied !== plan.changes.length) {
        console.error(`状态列回填：计划 ${plan.changes.length} 行、实际改 ${applied} 行，不一致，拒绝静默继续`);
        process.exit(1);
      }
      await writeFile(PENDING_PATH, md, 'utf8');
      console.log(`待签批清单状态列已回填 ${applied} 行（结论与日期均派生自审批记录台账，未做任何签批决定）`);
      console.log(`  → ${PENDING_PATH}`);
    } else {
      console.log(`待签批清单状态列：已核对 ${plan.inspected} 行，无需回填`);
    }
  } else {
    console.log('待签批清单状态列：按 --no-pending-status 跳过');
  }

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
