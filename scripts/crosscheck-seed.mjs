/**
 * 核对记录播种器：为「需签批但还没有核对行」的派单插入**骨架行**
 *
 * ── 为什么做 ────────────────────────────────────────────────────────────
 * 现状：每派一单，`validate` 的交叉对账就要求补一行核对记录，而这一行要**手抄**
 * 派单号、审批单号、以及那一大段「专家原始结论（引自派单日志，不得改写）」。
 * 手抄长文本正是本轮已经出过事的地方（一个裸竖线就把核对记录的一个格劈成了两半）。
 * 于是每提交一次就欠一次账 —— 这就是「签批跑步机」。
 *
 * ── 它做什么、不做什么 ──────────────────────────────────────────────────
 * 做：**机械列**（派单号、审批单号、专家原始结论、复核人）**从派单日志派生**，
 *     一个字都不手抄。原文**逐字复制**，不改写。
 * 不做：**判断列**（复核方式/复核结论/可验证反证/差集说明/处置）一律留 `（待填）`。
 *
 * ⚠ 骨架**不算**核对记录：`validate` 的交叉对账有显式检查拒绝含「待填/TODO/TBD/待补」
 *   的行，所以插了骨架**不会**让门禁变绿——它只是替你把该填的位置标出来。
 *   这一点是本脚本存在的全部前提：若骨架能过门禁，它就变成了绕过复核的后门。
 *
 * ── 插入位置 ────────────────────────────────────────────────────────────
 * 按派单号**字典序**插在第一个更大的单号之前（DSP-YYYYMMDD-HHMM-NN 的字典序
 * 与时间序一致）。不追加到末尾——末尾追加会让台账的时间序乱掉，
 * 而时间序乱掉之后「最后一条是谁」就得靠猜，那正是本体系反复吃亏的地方。
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRunbook, isBarePlaceholder } from './lib/runbook.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PENDING = '（待填）';
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);

/**
 * 「整格就是占位符」的判定住在 `lib/runbook.mjs`（`isBarePlaceholder`）——
 * `crosscheck-seed` 插骨架、`validate` 拦骨架、`selftest` 钉行为，三方共用一处定义。
 * 曾经在本文件里内联过一份，而 validate 里又内联了另一份：**两份正则只要有一份更宽松，
 * 那道门就形同虚设**，而这正是本体系反复吃亏的地方（黑名单/关键词的宽松侧永远先漏）。
 */

/** 纯函数：算出要插入哪些骨架行（便于 selftest 覆盖，不依赖文件系统）
 *  @param {string[][]} dispatchRows 派单日志的行（列序见 lib/runbook.mjs dispatchRecords）
 *  @param {string} crossMd          核对记录全文
 *  @param {boolean} onlyNeedSign    只给「需签批=Y」的派单播种（默认 true）
 */
export function planSeed(dispatchRows, crossMd, onlyNeedSign = true) {
  const crossIds = new Set(String(crossMd).split(/\r?\n/)
    .filter((l) => l.startsWith('| DSP-'))
    .map((l) => (l.split('|')[1] || '').trim()));

  const seeds = [];
  for (const d of dispatchRows) {
    const [dspId, time, subject, , , , , conclusion, needSign] = d;
    if (!dspId) continue;
    // 核对记录的要求只对「需签批」的派单成立；给不需要签批的也播种会凭空多出十几行空壳。
    if (onlyNeedSign && !/^\s*Y\s*$/i.test(String(needSign || ''))) continue;
    if (crossIds.has(dspId)) continue;
    seeds.push({
      dspId,
      apId: dspId.replace(/^DSP-/, 'AP-'),
      // 逐字复制，不改写。若原文含裸竖线则**拒绝播种**——它会切列，
      // 而这一格恰恰是「不得改写」的原文，错了就没法事后察觉。
      conclusion: String(conclusion || '').trim() || '（派单日志该格为空，请回原文补齐）',
      subject: String(subject || '').trim(),
      time: String(time || '').trim(),
    });
  }
  seeds.sort((a, b) => (a.dspId < b.dspId ? -1 : (a.dspId > b.dspId ? 1 : 0)));
  return seeds;
}

/** 纯函数：把骨架行插进核对记录文本（按单号字典序） */
export function applySeed(crossMd, seeds) {
  if (!seeds.length) return { md: String(crossMd), applied: 0 };
  const lines = String(crossMd).split(/\r?\n/);

  // 定位最后一行数据行，插在它之后或更靠前的正确位置
  let lastData = -1;
  for (let i = 0; i < lines.length; i++) if (lines[i].startsWith('| DSP-')) lastData = i;
  if (lastData < 0) throw new Error('核对记录里一行数据行都没有，定位失败，拒绝插入（不猜表结构）');

  // 列数取自既有数据行——不写死。写死过一次，代价是读到了隔壁列还照样输出「0 处异常」。
  const nCol = lines[lastData].split('|').length;
  const pending = [...seeds];
  const inserted = [];
  // 行首单号：非表格行（标题/空行/结束标记）会切出 undefined，**必须兜住**——
  // 否则在核对记录末尾的注释行上崩掉，而错误信息完全指不到真正的原因。
  const idAt = (line) => {
    const parts = String(line || '').split('|');
    return (parts[1] === undefined ? '' : parts[1]).trim();
  };
  // 核对记录的 8 个数据列（表头实测）：
  //   0 派单号 / 1 审批单号 / 2 专家原始结论 / 3 复核方式 / 4 复核结论
  //   5 可验证反证、差集说明（**这两项在同一格**）/ 6 处置 / 7 复核人
  // ⚠ 我第一版按「9 列」写骨架，插入直接被列数断言挡住——这正是断言该做的事。
  const buildRow = (s) => [
    s.dspId, s.apId,
    `**【原文·引自派单日志 ${s.time}，未改写】** ${s.conclusion}`,
    PENDING, PENDING, PENDING, PENDING, PENDING,
  ];
  for (let i = lastData + 1; i <= lines.length && pending.length; i++) {
    while (pending.length && (i > lines.length || pending[0].dspId < idAt(lines[i]))) {
      const s = pending.shift();
      const row = buildRow(s);
      if (row.length !== nCol - 2) {
        throw new Error(`骨架行 ${row.length} 列与既有数据行 ${nCol - 2} 列不符，拒绝插入`
          + '（表结构可能变了，先人工核对）');
      }
      for (const c of row) if (String(c).indexOf('|') >= 0) throw new Error(`骨架行含裸竖线，会切列：${s.dspId}`);
      lines.splice(i, 0, '| ' + row.join(' | ') + ' |');
      inserted.push(s.dspId);
      i++;   // 插入后索引后移
    }
  }
  // 若 pending 还有剩（都大于所有既有行），追加到末尾
  while (pending.length) {
    const s = pending.shift();
    const row = buildRow(s);
    if (row.length !== nCol - 2) throw new Error('骨架行列数不符');
    for (const c of row) if (String(c).indexOf('|') >= 0) throw new Error('骨架行含裸竖线');
    lines.splice(lastData + 1 + inserted.length, 0, '| ' + row.join(' | ') + ' |');
    inserted.push(s.dspId);
  }
  return { md: lines.join('\n'), applied: inserted.length };
}

async function main() {
  const book = await readRunbook(ROOT);
  if (!book.dispatch.md || !book.crosscheck) {
    // crosscheck 不在 RUNBOOK_FILES 里，直接读
  }
  const crossPath = join(ROOT, 'docs', 'expert-team', 'runbook', '核对记录.md');
  const crossMd = await readFile(crossPath, 'utf8');
  const seeds = planSeed(book.dispatchTable.rows, crossMd);

  // 已存在但整格仍是占位符的行，也要报出来——它们同样是「欠账」
  const unfilled = String(crossMd).split(/\r?\n/)
    .filter((l) => l.startsWith('| DSP-') && l.split('|').slice(1, -1).some(isBarePlaceholder))
    .map((l) => (l.split('|')[1] || '').trim());

  if (has('--json')) {
    console.log(JSON.stringify({ missing: seeds.map((s) => s.dspId), unfilled }, null, 2));
    return;
  }
  if (has('--check')) {
    if (!seeds.length && !unfilled.length) {
      console.log(`核对记录：${book.dispatchTable.rows.length} 条派单全部有核对行，且无「待填」占位 ✓`);
      return;
    }
    console.error(`核对记录欠账：缺行 ${seeds.length} 条${seeds.length ? '（' + seeds.map((s) => s.dspId).join(' ') + '）' : ''}；`
      + `有「待填」占位 ${unfilled.length} 条${unfilled.length ? '（' + unfilled.join(' ') + '）' : ''}`);
    process.exit(1);
  }

  if (!seeds.length) {
    console.log(`核对记录：无缺行${unfilled.length ? `；但有 ${unfilled.length} 行仍是「待填」骨架，须补齐复核` : ''}`);
  } else {
    const { md, applied } = applySeed(crossMd, seeds);
    if (applied !== seeds.length) {
      console.error(`播种：计划 ${seeds.length} 行、实际插入 ${applied} 行，不一致，中止`);
      process.exit(1);
    }
    await writeFile(crossPath, md, 'utf8');
    console.log(`已插入 ${applied} 行骨架：${seeds.map((s) => s.dspId).join(' ')}`);
    console.log('  机械列（派单号/审批单号/专家原文）均从派单日志派生，逐字复制；');
    console.log('  判断列一律「（待填）」——**骨架不算核对记录，门禁仍会红**，须补齐复核方式/结论/反证/处置。');
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  main().catch((e) => { console.error(e.message || e); process.exit(1); });
}
