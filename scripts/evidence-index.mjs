/**
 * 证据索引：让「可追溯率 100%」从口号变成可核查的事实
 *
 * 问题（2026-09-27 由 expert/20-docs 在真实派单评审 DSP-20260927-0030-02 中查出）：
 * `审批记录.md` 的证据列明文要求含四项——提示词版本 / 工具调用 / 输出哈希 / 门禁结论——
 * 但已登记的 6 行里，「提示词版本」与「输出哈希」**一项都没填**（含人工登记的）。
 * 即制度写得很严，实际零执行，「可追溯率 100%」是假的。
 *
 * 为什么用独立索引而不是改台账：
 *   台账规矩是「已签批记录不改写、不删除」。往已签批行里补内容属于改写。
 *   故本脚本生成 `runbook/证据索引.md`，按 AP 号补齐机器可算的两项，
 *   台账证据列只需引用本文件即可闭环——改的是派生物，不是签批事实。
 *
 * 机器可算的两项：
 *   提示词版本 = 该派单批次时点 .opencode/agents/ 的最后改动 commit（SHA 短哈希）
 *   输出哈希   = 对应 DSP 派单行正文的 sha256 前 12 位（结论内容的指纹）
 * 另两项（工具调用 / 门禁结论）本就写在台账证据列里，索引只做交叉引用。
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRunbook, dispatchRecords, approvalRecords, RUNBOOK_FILES } from './lib/runbook.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs', 'expert-team', 'runbook', RUNBOOK_FILES.evidence);

const sha12 = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 12);

function gitOut(args) {
  // 用同步版彻底避开 promisify(execFile) 返回形态的版本差异（本机 Node 26 返回 {stdout}，
  // 部分版本返回裸字符串；两次误判都源于此）。同步版返回稳定的字符串/Buffer。
  const r = execFileSync('git', ['-C', ROOT, ...args], { maxBuffer: 4e6, encoding: 'utf8' });
  return String(r ?? '').trim();
}

/** 从派单行的事项摘要里抽出批次首个 commit（形如 (197ec1b8, d6ae6c4f, …)） */
function batchHead(dspRow) {
  const m = /[(（]([0-9a-f]{7,40})/.exec(dspRow);
  return m ? m[1] : null;
}

/**
 * 提示词版本 = 该签批时点之前，.opencode/agents/ 的最后一次改动 commit。
 * 优先用派单批次里的 commit（若摘要里有），否则回退到「签批日期之前的最后一次 agent 改动」——
 * 后者对早期派单行同样有效，因为 agent 定义的版本随 git 历史可追溯。
 */
function resolvePromptVersion(dsp, a) {
  const head = dsp ? batchHead(dsp.subject || '') : null;
  if (head) {
    try {
      const c = gitOut(['log', '-1', '--format=%h', head, '--', '.opencode/agents/']);
      if (c) return `${c}（批次 ${head.slice(0, 8)} 时点的 agent 定义）`;
    } catch { /* 回退 */ }
  }
  const when = (a.signedAt || a.date || '').slice(0, 10);   // YYYY-MM-DD
  try {
    // --before 的值绝不能含空格：经 execFile 传参会拆成两个参数而失败（实测踩过）
    const c = when
      ? gitOut(['log', '-1', `--before=${when}T23:59:59`, '--format=%h', '--', '.opencode/agents/'])
      : gitOut(['log', '-1', '--format=%h', '--', '.opencode/agents/']);
    return c ? `${c}（签批日 ${when || '—'} 前的最后一次 agent 定义改动）` : '（历史中无 agent 目录改动）';
  } catch { return '（无法解析）'; }
}

async function build() {
  const book = await readRunbook(ROOT);
  const dispatches = dispatchRecords(book);
  const approvals = approvalRecords(book);
  const byDsp = new Map(dispatches.filter((d) => d.dsp).map((d) => [d.dsp.id, d]));

  const rows = [];
  for (const a of approvals) {
    if (!a.ap) continue;
    const dsp = a.dsp ? byDsp.get(a.dsp.id) : null;
    const promptVer = resolvePromptVersion(dsp, a);
    const outHash = dsp ? sha12(dsp.subject + '|' + dsp.raw + '|' + dsp.humanA + '|' + dsp.R) : '（无对应派单行）';
    const gate = dsp ? (/(门禁\d[^；;，,]*)/.exec(dsp.raw || '') || [null, ''])[1] : '';
    const ev = a.evidence || '';
    rows.push({
      ap: a.ap.id, dsp: a.dsp ? a.dsp.id : '—', subject: (a.subject || '').slice(0, 40),
      conclusion: a.conclusion || '—', signedAt: a.signedAt || a.date || '—',
      promptVer, outHash,
      tools: /工具调用|selftest|guard-audit|validate|doctor/.test(ev) ? '✅ 台账证据列已记' : '⚠ 未见',
      gate: gate || (/门禁/.test(ev) ? '✅ 台账证据列已记' : '⚠ 未见'),
    });
  }
  return rows;
}

function render(rows) {
  const L = [];
  L.push('# 证据索引（机器可算部分自动生成）');
  L.push('');
  L.push('> 由 `node scripts/evidence-index.mjs` 生成，**勿手改**。');
  L.push('> 用途：把 `审批记录.md` 证据列要求的四项补齐到可核查状态——');
  L.push('> 「提示词版本」「输出哈希」在此机器生成；「工具调用」「门禁结论」见台账证据列。');
  L.push('> 依据：`审批记录.md`「证据归档(提示词版本+工具调用+输出哈希+门禁结论)」列定义。');
  L.push('');
  L.push('| 审批单号 | 关联派单 | 签批结论 | 签批时间 | 提示词版本 | 输出哈希 | 工具调用 | 门禁结论 |');
  L.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const r of rows) {
    L.push(`| ${r.ap} | ${r.dsp} | ${r.conclusion} | ${r.signedAt} | ${r.promptVer} | \`${r.outHash}\` | ${r.tools} | ${r.gate} |`);
  }
  L.push('');
  const miss = rows.filter((r) => /无法|无对应/.test(r.promptVer) || /无对应/.test(r.outHash));
  L.push(`> 覆盖：${rows.length} 笔签批，其中 **${rows.length - miss.length} 笔**的提示词版本与输出哈希均可追溯${miss.length ? `；${miss.length} 笔缺批次 commit 信息，需人工补` : ''}。`);
  return L.join('\n');
}

async function main() {
  const rows = await build();
  const text = render(rows);
  if (process.argv.includes('--check')) {
    const cur = await readFile(OUT, 'utf8').catch(() => '');
    // 生成时间不入正文，故可比对
    if (cur.trim() === text.trim()) { console.log('证据索引：最新 ✓'); return; }
    console.error('证据索引：已过期，请运行 node scripts/evidence-index.mjs');
    process.exit(1);
  }
  await writeFile(OUT, text + '\n', 'utf8');
  console.log(`证据索引已刷新：${rows.length} 笔签批`);
  for (const r of rows) console.log(`  ${r.ap}  提示词版本=${r.promptVer.slice(0, 42)}  输出哈希=${r.outHash}`);
}

main().catch((e) => { console.error(e.message || e); process.exit(2); });