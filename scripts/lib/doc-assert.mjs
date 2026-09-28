/**
 * 文档「可证伪断言」的登记与核对
 *
 * ── 为什么做（人类 A 立项）──────────────────────────────────────────────
 * `06 §7.4` 记录过一个缺口：**文档正文里的事实断言没有任何自动检查**。
 * 缺口在 2026-09-28 兑现了两次：
 *   ① `DSP-20260928-1658-01`：`06 §7.1` 写着「watcher 没有任何项目模块的 import」，
 *      而同一提交里就有那个 import；
 *   ② `DSP-20260928-1730-01`：expert/20-docs 指出 `04` 里把 `approval-sync` 的
 *      写目标写成「三个（含度量看板）」，而它只写两个——**度量看板是 `dispatch-metrics` 写的**。
 * 两次都**不是靠检查发现的，是靠专家评审发现的**。
 *
 * ── 形式化方案（`06 §7.4` 明确要求「先解决形式化，而不是先写检查」）──────────
 * 一句文档断言要能被机械核对，必须先回答：**核对它需要什么？** 本模块的答案是：
 *   · 断言所在的那一行，用**行尾 HTML 注释**标记要核对哪个 checkId（渲染时不可见）：
 *       `| \`approval-sync.mjs\` | …写目标有两个… |  <!--核:approval-sync-writes-->`
 *   · checkId 在本模块的 `DOC_CHECKS` 里登记，登记内容是**去代码里核对什么**。
 *
 * 关键：**标记只是指针，判断力全在代码侧的检查里**。文档说「写目标有两个」不算数，
 *   要数的是 `scripts/approval-sync.mjs` 里 `await writeFile(` 出现几次。
 *
 * ── 三条让它不至于变成「表演性标注」的性质 ─────────────────────────────
 * 1. **未登记的 checkId 直接报红**。否则可以随手标一个不存在的 id，
 *    看起来「已标注已核对」，实际什么都没查——**那比不标更坏**。
 * 2. **已登记但文档里找不到标记 → 报红**。否则重写文档时不小心删了标记，
 *    检查会静默退化成「什么都不查」而仍然全绿——**这是本体系最熟悉的那种假绿**。
 * 3. **检查必须读代码/仓库，不许读文档**。文档是被检查对象，不是判据来源；
 *    拿文档自己证明文档自己没有意义。
 *
 * ── 诚实的边界（不得在任何文档里夸大）──────────────────────────────────
 * · 本模块**只能核对被显式标记的断言**。没标记的文档断言**依然无人核对**。
 * · 标记的粒度是「作者认为值得核对的那几句」，不是「文档里所有可证伪的话」。
 * · 因此它的准确说法是：**它把「我标注过的断言」变成有门禁的断言**，
 *   **不是**「文档已自动核实」。`06 §8.4` 那个缺口被缩小了，没有被消灭。
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * checkId → 检查函数。
 * 每个检查返回 { ok: boolean, detail: string }。detail 必须写清**实际观测到的值**，
 * 不能只写 ok/不 ok——否则报错时人类还得自己去重算一遍。
 */
export const DOC_CHECKS = {
  /**
   * `04` 的脚本清单曾把 `approval-sync` 的写目标写成「三个：签批状态视图、度量看板、
   * 以及待签批清单的状态列」。实际它只写两个；**度量看板由 `dispatch-metrics` 写**。
   * 由 expert/20-docs 在 DSP-20260928-1730-01 指出。
   */
  'approval-sync-writes': async (root) => {
    const src = await readFile(join(root, 'scripts', 'approval-sync.mjs'), 'utf8');
    const nWrite = (src.match(/await writeFile\(/g) || []).length;
    const view = /RUNBOOK_FILES\.view/.test(src);
    const pending = /RUNBOOK_FILES\.pending/.test(src);
    const metrics = /RUNBOOK_FILES\.metrics/.test(src);
    const ok = nWrite === 2 && view && pending && !metrics;
    return {
      ok,
      detail: `approval-sync 的 await writeFile 出现 ${nWrite} 次（期望 2）；`
        + `引用 view=${view}、pending=${pending}、metrics=${metrics}（期望 true/true/false）`,
    };
  },

  /**
   * `04` 声明 watcher 的源码指纹覆盖 `watcher + scripts/lib/`。
   * 这条曾被 §7.1 的错误讨论带偏过（「指纹要不要扩到 gate 脚本」），
   * 把它钉住可防止以后有人为了省事**缩小**覆盖范围。
   */
  'fingerprint-covers-lib': async (root) => {
    const src = await readFile(join(root, 'scripts', 'autodispatch-watcher.mjs'), 'utf8');
    const hasLibDir = /join\(root, 'scripts', 'lib'\)/.test(src);
    const hasMjs = /\.mjs'\)/.test(src);
    const ok = hasLibDir && hasMjs;
    return { ok, detail: `sourceFingerprint 覆盖 scripts/lib 目录=${hasLibDir}、只收 .mjs=${hasMjs}（期望 true/true）` };
  },
};

const MARK_RE = /<!--\s*核\s*[：:]\s*([A-Za-z0-9_-]+)\s*-->/g;

/** 扫一个文档文件里出现的 checkId 列表 */
export function markersIn(md) {
  const out = [];
  for (const m of String(md || '').matchAll(MARK_RE)) out.push(m[1]);
  return out;
}

/** 递归列出 docs/expert-team 下的 markdown 文件（相对 root） */
export async function listDocFiles(root) {
  const base = join(root, 'docs', 'expert-team');
  const out = [];
  const walk = async (dir) => {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name.endsWith('.md')) out.push(p.slice(root.length + 1).replace(/\\/g, '/'));
    }
  };
  await walk(base);
  return out;
}

/**
 * 核对全部已标记断言 + 双向完整性。
 * @returns {{violations:Array, checked:number, marked:number, filesScanned:number, registered:number}}
 */
export async function auditDocAssertions(root) {
  const files = await listDocFiles(root);
  const violations = [];
  const seen = new Map();   // checkId → 出现在哪些文件
  let marked = 0;

  for (const rel of files) {
    const md = await readFile(join(root, rel), 'utf8');
    for (const id of markersIn(md)) {
      marked++;
      if (!seen.has(id)) seen.set(id, []);
      seen.get(id).push(rel);
    }
  }

  // ① 标记了但没登记 → 报红（防止「标注即已核对」的表演）
  for (const [id, where] of seen) {
    if (!(id in DOC_CHECKS)) {
      violations.push({ id, why: 'unregistered', detail: `${where.join(', ')} 标注了 \`<!--核:${id}-->\`，但代码里没有登记该 checkId——**标了不等于查了**` });
    }
  }
  // ② 登记了但文档里没有标记 → 报红（防止重写文档后检查静默失效）
  for (const id of Object.keys(DOC_CHECKS)) {
    if (!seen.has(id)) {
      violations.push({ id, why: 'orphan-check', detail: `代码里登记了 \`${id}\` 的检查，但文档里已找不到 \`<!--核:${id}-->\`——**要么文档被改写掉了标记，要么这条检查已形同虚设**` });
    }
  }
  // ③ 真跑检查
  let checked = 0;
  for (const [id, fn] of Object.entries(DOC_CHECKS)) {
    if (!seen.has(id)) continue;      // 孤儿已在 ② 报过，不重复
    checked++;
    let r;
    try { r = await fn(root); }
    catch (e) { violations.push({ id, why: 'check-threw', detail: `检查执行抛错：${e.message || e}` }); continue; }
    if (!r.ok) violations.push({ id, why: 'mismatch', detail: r.detail });
  }

  return { violations, checked, marked, filesScanned: files.length, registered: Object.keys(DOC_CHECKS).length };
}
