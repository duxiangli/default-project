/**
 * 台账医生：派单写完后的结构自检 + 自动修复
 *
 * 背景（2026-09-27 真实派单实测）：router 手工编辑 Markdown 台账时反复犯四类错——
 *   ① 锚点被插在表格中间 → 后续追加的所有行被解析器静默忽略（审计链无声断裂）
 *   ② 数据行缺列（8 列 vs 表头 9 列）
 *   ③ 数据行之间混入空行 → Markdown 表被断成两段
 *   ④ 缺收尾竖线 / 单号重复
 * 这四类都不报错、只静默丢数据，靠人眼发现不了，而 router 无命令执行权无法自检。
 * 故把「自检 + 修复」下沉到代码：watcher 每次派单后立即跑本脚本。
 *
 * 用法：
 *   node scripts/ledger-doctor.mjs --check   # 只检测不修改（CI 用；有问题 exit 1）
 *   node scripts/ledger-doctor.mjs --fix     # 检测并自动修复可修复项
 *   node scripts/ledger-doctor.mjs --fix --json
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 三张表的规格：数据行前缀 / 表头前缀 / 列数 / 末尾锚点 */
export const SPECS = [
  { rel: 'docs/expert-team/runbook/派单日志.md', row: /^\| DSP-/, head: '| 派单号', cols: 9, anchor: '<!-- dispatch-log-end -->' },
  { rel: 'docs/expert-team/runbook/待签批清单.md', row: /^\| AP-/, head: '| 审批单号', cols: 9, anchor: '<!-- pending-approval-end -->' },
  { rel: 'docs/expert-team/runbook/审批记录.md', row: /^\| AP-/, head: '| 审批单号', cols: 13, anchor: '<!-- approval-ledger-end -->' },
];

/** 检测（纯函数）：返回 { issues, repairs } */
export function analyze(text, spec) {
  const issues = [];
  const repairs = [];
  const lines = text.split('\n');

  // (1) 锚点位置：必须在最后一行数据之后
  const dataIdx = lines.map((l, i) => (spec.row.test(l) ? i : -1)).filter((i) => i >= 0);
  const aIdx = lines.findIndex((l) => l.includes(spec.anchor));
  if (!dataIdx.length) issues.push({ kind: 'no-data', msg: '无数据行' });
  if (aIdx === -1) issues.push({ kind: 'no-anchor', msg: `缺锚点 ${spec.anchor}` });
  else if (dataIdx.length && aIdx < dataIdx[dataIdx.length - 1]) {
    issues.push({ kind: 'anchor-misplaced', msg: `锚点在第 ${aIdx + 1} 行、末行数据在第 ${dataIdx[dataIdx.length - 1] + 1} 行（后续追加将被忽略）` });
    repairs.push({ kind: 'move-anchor-to-end' });
  }

  // (2) 数据行之间的空行
  for (let k = 1; k < dataIdx.length; k++) {
    if (lines.slice(dataIdx[k - 1] + 1, dataIdx[k]).some((l) => l.trim() === '')) {
      issues.push({ kind: 'blank-in-table', msg: `第 ${dataIdx[k] + 1} 行前有空行，表被断开` });
      repairs.push({ kind: 'strip-blank-in-table' });
    }
  }

  // (3) 列数 / 收尾竖线 / 单号重复
  const seen = new Map();
  for (const i of dataIdx) {
    const cells = lines[i].split('|');
    const n = cells.length - 2;
    if (n !== spec.cols) {
      issues.push({ kind: 'col-count', msg: `第 ${i + 1} 行列数 ${n} ≠ ${spec.cols}`, line: i });
      repairs.push({ kind: 'pad-cols', line: i, from: n });
    }
    if (!lines[i].trimEnd().endsWith('|')) {
      issues.push({ kind: 'no-trailing-pipe', msg: `第 ${i + 1} 行缺收尾竖线`, line: i });
      repairs.push({ kind: 'add-trailing-pipe', line: i });
    }
    const id = (lines[i].split('|')[1] || '').trim();
    if (id) {
      if (seen.has(id)) {
        issues.push({ kind: 'dup-serial', msg: `单号重复 ${id}（第 ${seen.get(id) + 1} 行与第 ${i + 1} 行）`, line: i });
        repairs.push({ kind: 'drop-dup', line: i, id });
      } else seen.set(id, i);
    }
  }
  return { issues, repairs };
}

/** 修复（纯函数）：返回 { text, applied } */
export function repair(text, spec) {
  const { repairs } = analyze(text, spec);
  const applied = [];
  if (!repairs.length) return { text, applied };

  let lines = text.split('\n');
  const dropLines = new Set(repairs.filter((r) => r.kind === 'drop-dup').map((r) => r.line));

  for (const r of repairs) {
    if (r.kind === 'move-anchor-to-end') {
      lines = lines.filter((l) => !l.includes(spec.anchor));
      while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
      lines.push('', spec.anchor);
      applied.push('锚点已移至文件末尾');
    }
  }
  // 逐行修复（行号会因删除/插入而变，故用 id 重新定位）
  const dataRe = spec.row;
  for (const r of repairs) {
    if (r.kind === 'strip-blank-in-table') {
      const out = [];
      let prevData = false;
      let removed = 0;
      for (const l of lines) {
        const isData = dataRe.test(l);
        if (prevData && l.trim() === '') { removed++; continue; }
        out.push(l); prevData = isData;
      }
      lines = out;
      applied.push(`移除表格内空行 ${removed} 处`);
    }
    if (r.kind === 'drop-dup' && dropLines.size) {
      // 逐个按单号去重，保留首次出现
      const seenId = new Set();
      const out = [];
      let dropped = 0;
      for (const l of lines) {
        if (dataRe.test(l)) {
          const id = (l.split('|')[1] || '').trim();
          if (id && seenId.has(id)) { dropped++; continue; }
          if (id) seenId.add(id);
        }
        out.push(l);
      }
      lines = out;
      applied.push(`移除重复单号行 ${dropped} 行`);
      dropLines.clear();
    }
  }
  for (const r of repairs) {
    if (r.kind === 'pad-cols' || r.kind === 'add-trailing-pipe') {
      const hdrIdx = lines.findIndex((l) => l.startsWith(spec.head));
      const hdrCols = hdrIdx >= 0 ? lines[hdrIdx].split('|').slice(1, -1).map((c) => c.trim()) : [];
      let padded = 0, piped = 0;
      lines = lines.map((l) => {
        if (!dataRe.test(l)) return l;
        let cells = l.split('|');
        const trailingEmpty = cells[cells.length - 1] === '';
        if (trailingEmpty) cells = cells.slice(0, -1);
        // ⚠ 这里只能 slice(1)（去掉首部的前导空串），**不能再 slice(-1)**：
        //   上一行已剥掉尾部空串，此处再剥一刀会把**最后一格真实数据**切掉——
        //   接着 `< spec.cols` 分支会用「—」把它补回来，于是一行的末列（需签批）
        //   被静默抹成「—」。2026-09-29 实测：只要有 1 行列数异常，本分支会重写
        //   全部数据行，导致**所有行的需签批被清空**（回归见 selftest §14②b）。
        let body = cells.slice(1).map((c) => c.trim());
        if (body.length < spec.cols) {
          for (let k = body.length; k < spec.cols; k++) {
            // 末列是「需签批」时不能臆造 Y/N：用「—」并要求人工/上游确认
            body.push('—');
          }
          padded++;
        }
        return `| ${body.join(' | ')} |`;
      });
      if (padded) applied.push(`补齐缺失列 ${padded} 行（缺失值填「—」，不臆造四态/需签批）`);
      void piped; void hdrCols;
    }
  }
  return { text: lines.join('\n'), applied };
}

async function main() {
  const argv = process.argv.slice(2);
  const doFix = argv.includes('--fix');
  const asJson = argv.includes('--json');
  const report = [];

  for (const spec of SPECS) {
    const p = join(ROOT, spec.rel);
    let text;
    try { text = await readFile(p, 'utf8'); }
    catch { report.push({ rel: spec.rel, issues: [{ kind: 'missing', msg: '文件不存在' }], applied: [] }); continue; }
    const { issues } = analyze(text, spec);
    let applied = [];
    let finalText = text;
    if (issues.length && doFix) {
      const r = repair(text, spec);
      finalText = r.text; applied = r.applied;
      if (applied.length) await writeFile(p, finalText, 'utf8');
      // 修复后复检
      const after = analyze(finalText, spec);
      if (after.issues.length) {
        report.push({ rel: spec.rel, issues: after.issues, applied, unrepaired: true });
        continue;
      }
    }
    report.push({ rel: spec.rel, issues, applied });
  }

  const bad = report.filter((r) => r.issues.length);
  const fixed = report.filter((r) => r.applied.length);
  if (asJson) { console.log(JSON.stringify({ ok: !bad.length, report }, null, 2)); }
  else {
    for (const r of report) {
      if (!r.issues.length) { console.log(`✅ ${r.rel}：结构正常${r.applied.length ? `（已修：${r.applied.join('；')}）` : ''}`); continue; }
      console.log(`${r.unrepaired ? '❌' : '⚠️ '} ${r.rel}：${r.issues.length} 个问题${r.applied.length ? `，已修 ${r.applied.join('；')}` : '（未修）'}`);
      for (const i of r.issues) console.log(`     - [${i.kind}] ${i.msg}`);
    }
    console.log(`\n台账体检：${report.length - bad.length} 表正常 / ${bad.length} 表仍有问题${fixed.length ? ` / ${fixed.length} 表已自动修复` : ''}`);
  }
  process.exit(bad.length ? 1 : 0);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  main().catch((e) => { console.error(e.message || e); process.exit(2); });
}