/**
 * 台账**列形态**自证：某一列装的东西必须符合该列的形态，而不是「看起来像」。
 *
 * ── 为什么要有（2026-09-29，人类 A 立项）──────────────────────────────────
 * `核对记录.md` 曾经有 **9 行整格错位**：我把「可验证反证」与「差集说明」当成两列分别填，
 * 而表头第 6 列名叫「可验证反证 / 差集说明」——**斜杠就表示合并成一格**。
 * 于是差集挤进了「处置」列、处置挤进了「复核人」列、**复核人直接丢失**。
 *
 * **它为什么能一路绿灯通过所有门禁**：列数是对的（8 列仍是 8 列），
 * 所以 `ledger-doctor` 的列宽检查、`validate` 的挂账纪律、`seed --check` 的占位符检查**全都抓不到**。
 * 错的不是列数，是**内容形态**。这个模块补的就是这一类。
 *
 * ── 关键：判定必须是「该列不该长什么样」，不是「该列该长什么样」 ──────────
 * 我第一版判处置列用的是**白名单正则**（匹配「① **已补登」这类开头），结果 39 行里报 35 行，
 * 绝大多数是误报——`无需处置（批准）`、`同上` 都是合法处置却没被匹配上。
 * **这就是我在别处反复批评的错误：黑名单/关键词判定只能挡住预想到的形态。**
 * 教训是当场付的，第二次犯错时它自己找上门。
 *
 * 本模块只判**可判定的形态**（字符集、长度、是否为空），不判措辞。
 *
 * ── 关键：对「字符集」用正向允许集（allowlist），对「措辞」不用白名单 ──────
 * 我第一版判「复核人」用的是**禁止集**（denylist：禁 ①②③、`，。；：`、`**`……），
 * 结果把**我自己的标准署名「助手（自动复核）」判成不合**——它含全角括号。
 * 上线当天就误报 18 行（其中只有 9 行是真错位）。**禁止集永远会漏**，因为总有没想到的字符。
 *
 * 这里必须分清两件事，之前我把它们混成了一句话：
 *   · **字符集**可以、也**应该**正向定义（allowlist）。「署名由哪些字符构成」是可判定的；
 *     允许集比禁止集可靠得多——**禁止集漏一个字符就是一次误报**。
 *   · **措辞**不能用白名单。`已补登`、`无需处置（批准）`、`同上` 都是合法内容，
 *     按措辞匹配实测报 35/39 行。**措辞必须完全自由。**
 * 所以「该长什么样」这句话，**对字符集成立、对措辞不成立**。
 *
 * ── 自证（必须有）───────────────────────────────────────────────────────
 * 输出「0 处违规」之前，必须先能回答「你比对了多少行、多少格」。
 * 否则「表读空了」与「全部合规」会输出同一句话。本轮已经栽过一次假零。
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * 短署名**允许**的字符集（正向定义）：
 * 中英文、数字、空格，以及署名里合理出现的分隔符：
 * 中点 ·、斜杠 /、连字符 -、下划线 _、点 .、井号 #、全角与半角括号。
 *
 * **不包含**逗号、句号、分号、冒号、圈号 ①②③、星号、引号、破折号——
 * 署名不会带这些，而错位进来的处置/差集文本一定带。
 * **这不是措辞白名单**：「助手（自动复核）」与「duxiangli / 助手复核」都通过。
 */
const SIGN_ALLOWED = /^[一-龥A-Za-z0-9 ·/\-_.#()（）]+$/;

/**
 * 形态判定器。每个判定器返回 { ok, why }——**why 必须写明实际观测到的特征**，
 * 不能只写 ok/不 ok，否则报错时人类还得自己重算。
 */
export const SHAPES = {
  /**
   * 短署名：人名或机构署名。
   * **正向**判据：字符全在 `SIGN_ALLOWED` 允许集内、长度 ≤ 24、非空。
   * 「助手（自动复核）」与「duxiangli / 助手复核」都通过；
   * 「① **已补登**（R 与门禁7 的条件已满足）…」因含 ① 与 * 且超长被拒。
   * **措辞完全自由**——这里一个词都不匹配。
   */
  'short-sign': (v) => {
    const s = String(v == null ? '' : v).trim();
    if (!s) return { ok: false, why: '为空' };
    const over = [];
    if (s.length > 24) over.push('长度 ' + s.length + ' > 24');
    if (!SIGN_ALLOWED.test(s)) {
      const bad = [...new Set([...s].filter((ch) => !SIGN_ALLOWED.test(ch)))].slice(0, 8);
      over.push('含署名不应有的字符 ' + bad.join(' ') + '（允许集：中文/英文/数字/空格/ · / - _ . # ( ) （ ））');
    }
    return over.length
      ? { ok: false, why: over.join('、') }
      : { ok: true, why: '短署名（' + s.length + ' 字）' };
  },

  /**
   * 会签格：要么 `—`（无需会签），要么 `—（…）` 的说明块。
   *
   * **这一条是我第二次套错判据记下的**：我第一版把「会签」也套上 `short-sign`，
   * 结果 37 行**全部误报**——因为这一列的实际内容是「—（签批人 duxiangli 2026-09-27 14:35）」，
   * 长度 33、含冒号，**它本来就不是短署名列**。
   *
   * 教训比第一次更具体：**加一列判据之前，必须先看清这一列的实际取值有几种骨架**。
   * 我是先套判据、跑出 37 条误报、再回头统计骨架的——**顺序反了**。
   * 正确的顺序是：读数据 → 归一化看骨架 → 再写判据。
   *
   * 判据只看**结构**（`—` 或 `—（…）` + 长度上限），不看里面写了谁、什么时间。
   */
  countersign: (v) => {
    const s = String(v == null ? '' : v).trim();
    if (!s) return { ok: true, why: '空（该列允许为空）' };
    if (s === '—' || s === '-') return { ok: true, why: '「—」（无需会签）' };
    if (s.length > 160) return { ok: false, why: '长度 ' + s.length + ' > 160（会签说明不该无限膨胀）' };
    if (!(s.startsWith('—（') && s.endsWith('）'))) {
      return { ok: false, why: '既不是「—」，也不是以「—（」开头并以「）」结尾的结构：实际前 30 字「' + s.slice(0, 30) + '」' };
    }
    return { ok: true, why: '「—（…）」结构（' + s.length + ' 字）' };
  },
};

/** 逐文件的列形态规格。加新列只改这里，不改判定逻辑。
 *  `rowPrefix` 必须**与本表数据行的前缀一致**，用它来定位「本表的表头」——
 *  不能取文件里第一个表（`审批记录.md` 开头就有一张 3 列的说明表）。 */
export const SPECS = [
  { file: '核对记录.md', col: '复核人', kind: 'short-sign', rowPrefix: '| DSP-' },
  { file: '审批记录.md', col: '会签', kind: 'countersign', rowPrefix: '| AP-' },
  { file: '派单日志.md', col: '需签批(Y/N)', kind: 'yn', rowPrefix: '| DSP-' },
];

/** 'optional'：允许为空，但非空时必须短（会签人名） */
function optional(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return { ok: true, why: '空（该列允许为空）' };
  return SHAPES['short-sign'](s);
}
/** 'yn'：只允许 Y / N / 空白 */
function yn(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return { ok: false, why: '为空（该列应为 Y 或 N）' };
  if (/^[YN]$/i.test(s)) return { ok: true, why: s.toUpperCase() };
  return { ok: false, why: '取值「' + s.slice(0, 20) + '」不是 Y/N' };
}
const EXTRA = { optional, yn };
const judge = (kind, v) => (EXTRA[kind] || SHAPES[kind] || (() => ({ ok: false, why: '未知形态 ' + kind })))(v);

const mdCells = (line) => line.split('|').slice(1, -1).map((s) => s.trim());

/**
 * 找**数据行所属那张表**的表头，不能取文件里第一个表。
 *
 * 我第一版写的是 `find((x) => x.startsWith('| '))`——取第一条表头行。
 * `审批记录.md` 开头 L8 就有一张**说明表**（结论/含义/生效条件，3 列），
 * 于是本模块去找「会签」列时在那张 3 列的说明表里找不到，报了 `no-column`。
 *
 * 改成：先按 `rowPrefix` 找到第一行数据，再**向上**取最近的非分隔行作表头。
 * 方向反了就会取到别的表——和「写死列索引」是同一类错误的两个面。
 */
function tableHeaderFor(text, rowPrefix) {
  const rows = text.split(/\r?\n/);
  const iData = rows.findIndex((l) => l.startsWith(rowPrefix));
  if (iData < 0) return null;
  for (let i = iData - 1; i >= 0; i--) {
    const l = rows[i];
    if (!l.startsWith('|')) continue;
    const cells = mdCells(l);
    // 跳过 Markdown 表格的分隔行（| --- | --- |）
    if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
    return cells;
  }
  return null;
}

/**
 * @returns {{violations:Array, rowsScanned:number, cellsJudged:number, specsApplied:number, filesRead:number}}
 */
export async function auditColumnShapes(root) {
  const violations = [];
  let rowsScanned = 0;
  let cellsJudged = 0;
  let filesRead = 0;

  for (const spec of SPECS) {
    const rel = join('docs', 'expert-team', 'runbook', spec.file);
    let text;
    try { text = await readFile(join(root, rel), 'utf8'); }
    catch (e) {
      violations.push({ file: spec.file, col: spec.col, id: '(整表)', why: 'read-failed', detail: '读不到 ' + spec.file + '：' + (e.message || e) });
      continue;
    }
    filesRead++;
    const rowPrefix = spec.rowPrefix;
    const head = tableHeaderFor(text, rowPrefix);
    if (!head) {
      violations.push({ file: spec.file, col: spec.col, id: '(整表)', why: 'no-column', detail: '在 ' + spec.file + ' 里找不到以「' + rowPrefix + '」开头的数据行，因而取不到表头' });
      continue;
    }
    // 列名**按名字定位**，不写死索引——写死索引已经坑过我两次（处置列 6 vs 7）
    const i = head.findIndex((h) => h.indexOf(spec.col) >= 0);
    if (i < 0) {
      violations.push({ file: spec.file, col: spec.col, id: '(整表)', why: 'no-column', detail: '表头里找不到含「' + spec.col + '」的列（实际表头：' + head.join(' / ') + '）' });
      continue;
    }
    let n = 0;
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith(rowPrefix)) continue;
      const c = mdCells(line);
      if (c.length !== head.length) continue;   // 列数不符的由 ledger-doctor 负责，不重复报
      n++; rowsScanned++;
      cellsJudged++;
      const r = judge(spec.kind, c[i]);
      if (!r.ok) {
        violations.push({
          file: spec.file, col: spec.col, id: c[0], index: i,
          why: 'shape', detail: '第 ' + (i + 1) + ' 格「' + spec.col + '」形态不合：' + r.why
            + '；实际内容前 40 字「' + String(c[i] || '').slice(0, 40) + '」',
        });
      }
    }
    if (n === 0) {
      violations.push({ file: spec.file, col: spec.col, id: '(整表)', why: 'no-rows', detail: spec.file + ' 有表头但切不出数据行（数据行前缀变了？）' });
    }
  }

  return { violations, rowsScanned, cellsJudged, specsApplied: SPECS.length, filesRead };
}
