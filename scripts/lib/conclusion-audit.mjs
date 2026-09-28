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
const PLACEHOLDER_VALUE = /(?:^|\s)(?:\.{3}|…|<[^>]*>|expert\/xx)\s*(?:\n|$)/;
/** 数一数「字段名在、但值是占位符」的有几个 */
export function placeholderFieldCount(block) {
  const s = String(block || '');
  let n = 0;
  for (const [name] of REQUIRED_FIELDS) {
    // 取该字段名之后、到下一个换行为止的内容
    const m = new RegExp(name + '\\s*[:：]\\s*([^\\n]*)').exec(s);
    if (m && PLACEHOLDER_VALUE.test(m[1])) n++;
  }
  return n;
}

export function isRealConclusion(b) {
  if (missingFields(b).length) return false;
  // 半数以上必填字段的值是占位符 → 回抄未填的退化块
  if (placeholderFieldCount(b) >= Math.ceil(REQUIRED_FIELDS.length / 2)) return false;
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
    if (ph >= Math.ceil(REQUIRED_FIELDS.length / 2)) {
      bogus.push({ b, why: `${ph} 个必填字段的值仍是占位符（回抄契约未填）` });
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
