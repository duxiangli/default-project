/**
 * 结论块有效性判定（纯函数，2026-09-28）
 *
 * 起因：DSP-20260928-1213-01 复核时踩到——`export-expert-conclusions.mjs` 的
 * `extractBlocks` 只认 `<!--结论` 标记，于是把**被引用的契约模板**、**JS 源码字符串**、
 * **文档示例**里的同名字样也当成专家结论导出。实测 1213-01 的 R 子会话里，
 * 一个 `<!--结论'` 出现在 validate 的源码里，取到的「块」横跨数百行代码——
 * 复核方拿到的是**假原文**。
 *
 * 为什么用正向判定而不是黑名单：我第一版按占位符（`事项: <一句话>` 等）做黑名单，
 * 实测**没匹配上**——因为污染源是代码字符串，里面根本没有那些占位符。
 * **黑名单只能挡住我预想到的污染。** 改判「像不像真结论」：
 * 契约要求四态/严重度/行动/升级对象，缺项就不是结论块。
 * 与本仓库免评审白名单护栏（whitelist-audit.mjs）同一思路。
 *
 * 与本模块同处一个错误的另一个方向：识别出来后**标注而非静默丢弃**。
 * 静默丢弃会把「少了一段」伪装成「本来就那么多」。
 */

export const REQUIRED_FIELDS = [
  ['四态', /四态\s*[:：]/],
  ['严重度', /严重度\s*[:：]/],
  ['行动', /行动\s*[:：]|动作\s*=/],
  ['升级对象', /升级对象\s*[:：]/],
];

/**
 * 从 `start`（指向某 `<!--`）起配平扫描到**匹配的** `-->`，返回其**之后**的下标；未闭合返回 -1。
 *
 * ── 为什么不能用 `indexOf('-->')`（2026-10-08 实测事故）──────────────────
 * 专家会在结论块的「依据」里**引用 anchor**，例如
 *   `… 待签批清单.md:49 报 \`<!-- pending-approval-end -->\` …`
 * 朴素扫描在**内层 `-->`** 处就收尾 → 块被截断在「依据」中途 → 缺「行动/升级对象」
 * → `isRealConclusion` 判不合格 → watcher 判「无结论」→ **fail-closed 反复重派**
 * （台账灌水 + 熔断 trips），且 `export-expert-conclusions.mjs` 会导出**截断原文**。
 * 全量实测：108 个含块专家子会话里，朴素扫描误判 3 个（≈2.8%），配平扫描 0 个。
 *
 * 规则：遇 `<!--` 深度 +1、遇 `-->` 深度 −1，归零处即本块结束。
 */
export function matchCommentEnd(text, start) {
  const s = String(text || '');
  let depth = 0;
  let k = start;
  while (k < s.length) {
    if (s.startsWith('<!--', k)) { depth += 1; k += 4; continue; }
    if (s.startsWith('-->', k)) {
      depth -= 1; k += 3;
      if (depth === 0) return k;
      continue;
    }
    k += 1;
  }
  return -1;
}

/**
 * 从一段文本里抽出所有 `<!--结论 … -->` 块（配平扫描，见 `matchCommentEnd`）。
 * 与 `export-expert-conclusions.mjs` 共用同一取法——**两份实现只要有一份更宽松，
 * 那道护栏就形同虚设**（本体系反复吃亏处）。
 * @param {string} text
 * @param {boolean} trim 是否 trim 每块（导出侧用 true）
 */
export function extractConclusionBlocks(text, trim = false) {
  const s = String(text || '');
  const out = [];
  let i = 0;
  const MARK = '<!--结论';
  while ((i = s.indexOf(MARK, i)) >= 0) {
    const end = matchCommentEnd(s, i);
    if (end < 0) {
      // 未闭合（如源码字符串里的 `'<!--结论'`）：**不得 break**——那会静默丢掉其后
      // **所有**块（实测见 06 §9.4）。只跳过这个标记，继续找下一个 `<!--结论`。
      i += MARK.length;
      continue;
    }
    const b = s.slice(i, end);
    out.push(trim ? b.trim() : b);
    i = end;
  }
  return out;
}

/**
 * 该候选是否具备「块形态」：真结论块必为**多行**（契约格式 `<!--结论\n事项: …`）。
 * 单行片段（如 `<!--结论x-->`、源码里的 `'<!--结论'`）是**源码字面量/文档样例**，
 * 不是块候选——子会话读取 `selftest.mjs` 等源码时会把它们大量带进来（实测见 06 §9.4）。
 *
 * 2026-10-08 由专家 `expert/14-qa-governance` 在 `DSP-20261008-1503-01` 指出：原先这层过滤
 * **内联在导出脚本里**、且**静默丢弃**、无断言。现下沉为可测纯函数，并把被滤项**显式返回**。
 */
export function isBlockShaped(b) {
  return String(b || '').includes('\n');
}

/**
 * 把候选块分成「块形态」与「源码字面量」两堆——后者**显式返回**而非静默丢弃
 * （专家要求：静默丢弃会把「少了一段」伪装成「本来就那么多」）。
 * @param {string[]} cands
 * @returns {{ blocks: string[], literals: string[] }}
 */
export function splitBlockCandidates(cands) {
  const blocks = [];
  const literals = [];
  for (const b of Array.isArray(cands) ? cands : []) (isBlockShaped(b) ? blocks : literals).push(b);
  return { blocks, literals };
}

/** 返回该文本缺失的必填字段名；空数组 = 字段齐全 */
export function missingFields(block) {
  const s = String(block || '');
  return REQUIRED_FIELDS.filter(([, re]) => !re.test(s)).map(([n]) => n);
}

/* ── 占位值检查：字段齐全**不等于**填了内容 ──
 * 2026-09-28 实测漏洞：专家回抄契约模板但没填，形如
 *   事项: ... / 四态: ... / 依据: ... / 行动: ... / 严重度: ...
 * 四个必填字段**名都在**，所以纯字段检查放行了它——而它不是结论。
 * 这与「代码字符串污染」是两种不同的失效，**只能各自设防**：
 *   · 字段名检查 → 挡代码/文档样例（里面根本没有字段名）
 *   · 占位值检查 → 挡回抄未填（字段名齐全但值是 ...）
 * 我先只做了前者，被 selftest 当场测出来（见 scripts/selftest.mjs 22.9）。
 */
const PLACEHOLDER_VALUE = /\.{3}|…|<[^>]*>|expert\/xx/;

/** 该字段的值里是否含占位符（`...` / `…` / `<...>` / `expert/xx`） */
function fieldHasPlaceholder(value) {
  return PLACEHOLDER_VALUE.test(String(value || ''));
}

/** 数一数「字段名在、但值含占位符」的有几个 */
export function placeholderFieldCount(block) {
  const s = String(block || '');
  let n = 0;
  for (const [name] of REQUIRED_FIELDS) {
    const m = new RegExp(name + '\\s*[:：]\\s*([^\\n]*)').exec(s);
    if (m && fieldHasPlaceholder(m[1])) n++;
  }
  return n;
}

export function isRealConclusion(b) {
  if (missingFields(b).length) return false;
  // ⚠ 判据收紧（2026-09-28）：**任一**必填字段的值含占位符即不合格。
  // 原来只要求「半数以上是占位符」，结果 router 提示词里的**契约模板**被判成真结论——
  //   该模板 `事项: <一句话>` 带尖括号，但 `四态: 建议批准 | 有条件通过 | …` 不是纯占位符，
  //   于是「占位值计数」没达标，模板被放行。
  //   而它会被 export 与 judgeDispatchConclusion 当成专家的真结论 —— **正是本次要堵的「假原文」。**
  //   真结论里绝不会出现 `<一句话>` 这种尖括号占位符，故任一命中即不合格。
  if (placeholderFieldCount(b) > 0) return false;
  return true;
}

/**
 * 把混在一起的候选块分成「真结论」与「非结论块」。
 * @returns {{real: string[], bogus: {b: string, why: string}[]}}
 */
export function partitionBlocks(candidates, maxLen = 8000) {
  const real = [];
  const bogus = [];
  for (const raw of candidates) {
    const b = String(raw || '').trim();
    if (!b) continue;
    if (b.length >= maxLen) { bogus.push({ b, why: `长度 ≥${maxLen}，疑似跨块误切` }); continue; }
    const miss = missingFields(b);
    if (miss.length) { bogus.push({ b, why: '缺契约必填字段：' + miss.join('/') }); continue; }
    const ph = placeholderFieldCount(b);
    if (ph > 0) {
      bogus.push({ b, why: `${ph} 个必填字段的值仍含占位符（回抄契约未填，或这是提示词里的模板）` });
      continue;
    }
    real.push(b);
  }
  return { real: [...new Set(real)], bogus: dedupeBogus(bogus) };
}

function dedupeBogus(list) {
  const seen = new Set();
  return list.filter((x) => (seen.has(x.b) ? false : (seen.add(x.b), true)));
}
