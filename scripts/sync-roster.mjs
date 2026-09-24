/**
 * 首席名册同步脚本（单一事实源 = docs/expert-team/roster/首席名册.csv）
 * 用法：node scripts/sync-roster.mjs
 * 将 岗位卡、OpenCode 专家Agent、路由表、体系总览、README 中的人类A 职位替换为「职位 · 姓名」。
 * 换人/改名流程：改 roster CSV → 跑本脚本 → 跑 scripts/validate-expert-team.mjs → 提交。
 */
import { readFile, writeFile, readdir } from 'node:fs/promises';

const rosterPath = 'docs/expert-team/roster/首席名册.csv';
const csv = await readFile(rosterPath, 'utf8');
const lines = csv.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
const rows = lines.slice(1).map((l) => {
  const [num, job, role, name, idName] = l.split(',');
  return { num, job, role, name, idName };
});
if (rows.length !== 20) throw new Error(`名册应为 20 行，实际 ${rows.length}`);

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
let changed = 0;

// 1) 岗位卡：头部「人类A（Accountable）：**职位**」与角色行「人类首席（职位）」→ 追加姓名
for (const f of await readdir('docs/expert-team/agent-cards')) {
  if (!/^\d{2}-.*\.md$/.test(f)) continue;
  const num = f.slice(0, 2);
  const row = rows.find((r) => r.num === num);
  if (!row) continue;
  const p = `docs/expert-team/agent-cards/${f}`;
  let c = await readFile(p, 'utf8');
  const before = c;
  c = c.replace(
    new RegExp(`人类A（Accountable）：\\*\\*${esc(row.role)}(?! ·)\\*\\*`),
    `人类A（Accountable）：**${row.role} · ${row.name}**`
  );
  c = c.replace(
    new RegExp(`人类首席（${esc(row.role)}(?! ·)）`, 'g'),
    `人类首席（${row.role} · ${row.name}）`
  );
  if (c !== before) {
    await writeFile(p, c, 'utf8');
    changed++;
  }
}

// 2) 路由表类文件（router.md、00-路由Agent卡、00-体系总览、README）：`| 职位 |` → `| 职位 · 姓名 |`
for (const p of [
  '.opencode/agents/router.md',
  'docs/expert-team/agent-cards/00-路由Agent.md',
  'docs/expert-team/00-体系总览.md',
  'README.md',
]) {
  let c = await readFile(p, 'utf8');
  const before = c;
  for (const r of rows) {
    c = c.replace(new RegExp(`\\| ${esc(r.role)}(?! ·) \\|`, 'g'), `| ${r.role} · ${r.name} |`);
  }
  if (c !== before) {
    await writeFile(p, c, 'utf8');
    changed++;
  }
}

// 3) OpenCode 专家Agent：角色行与原则行「人类首席（职位）」→「人类首席（职位 · 姓名）」（全局）
for (const f of await readdir('.opencode/agents/expert')) {
  if (!/^\d{2}-.*\.md$/.test(f)) continue;
  const num = f.slice(0, 2);
  const row = rows.find((r) => r.num === num);
  if (!row) continue;
  const p = `.opencode/agents/expert/${f}`;
  let c = await readFile(p, 'utf8');
  const before = c;
  c = c.replace(
    new RegExp(`人类首席（${esc(row.role)}(?! ·)）`, 'g'),
    `人类首席（${row.role} · ${row.name}）`
  );
  if (c !== before) {
    await writeFile(p, c, 'utf8');
    changed++;
  }
}

console.log(`roster: ${rows.length} 人；sync 更新 ${changed} 个文件`);