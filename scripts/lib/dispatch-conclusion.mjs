// 判定「这次派单是否真的产出了**符合契约的专家结论块**」。
//
// 为什么必须修（2026-09-28，DSP-20260928-1424-01 复核发现）：
//   原判定在 autodispatch-watcher.mjs 里是
//     `conclusion = texts.some(x => x.trim().length > 0) && errors.length === 0`
//   ——只要**有任何非空输出**就算「有结论」。
//   后果：实测同一 commit d80a39e 的 5 次派单中，有 **3 次零专家子会话**
//   （无任何专家评审），却照样 conclusion=true、照样留痕、照样推进 lastHead。
//   **这就是「结论凭空产生」的口子。** 本次没真的凭空产生，但门是敞开的。
//
// 为什么不能简单搜 `<!--结论`：
//   router 的提示词里**含结论块契约模板**，模板本身带 `<!--结论` 标记与占位符
//   （`事项: <一句话>`、`R: expert/xx`…）。按标记判会把**模板**当成结论。
//   这正是 scripts/lib/conclusion-audit.mjs 解决的问题（正向语义 + 占位值双防线），
//   本模块直接复用它，不重复实现。
//
// **诚实边界**：收紧后，若专家因故未按契约出块，派单会被判为「无结论」→
// 不推进基线 → 下轮重派。**这是 fail-closed 方向**（宁可重派也不放过未评审），
// 但代价是需要人介入；故同时把判定细节写进日志，便于定位是「没出块」还是「出块不合规」。

import { isRealConclusion, missingFields, placeholderFieldCount, extractConclusionBlocks } from './conclusion-audit.mjs';

/**
 * `extractConclusionBlocks` 的**配平扫描实现已下沉**到 `lib/conclusion-audit.mjs`
 * （与 `export-expert-conclusions.mjs` 共用同一取法，避免两份实现漂移——本体系反复吃亏处）。
 * 这里 re-export，保持既有 import 路径（selftest 等）。
 * 2026-10-08：朴素 `indexOf('-->')` 会在块内引用的内层 `-->`（如 `` `<!-- pending-approval-end -->` ``）处截断，
 * 导致合规块缺「行动/升级对象」→ 判「无结论」→ 反复重派。见 `matchCommentEnd` 注释。
 */
export { extractConclusionBlocks };

/**
 * @param {string[]} texts  派单会话的文本产出
 * @returns {{ok:boolean, blocks:number, real:number, why:string, detail:string}}
 */
export function judgeDispatchConclusion(texts) {
  const arr = Array.isArray(texts) ? texts : [];
  const all = [];
  for (const t of arr) for (const b of extractConclusionBlocks(String(t || ''))) all.push(b);
  const real = all.filter((b) => isRealConclusion(b));
  if (real.length) {
    return { ok: true, blocks: all.length, real: real.length, why: '', detail: '' };
  }
  if (!all.length) {
    return {
      ok: false, blocks: 0, real: 0,
      why: '无结论块',
      detail: '会话产出里连 `<!--结论` 标记都没有——可能未真正派单、或专家未按契约出块',
    };
  }
  // 有标记但都不合规：区分「缺字段」与「字段齐全但值是占位符」，便于定位
  const first = all[0];
  const miss = missingFields(first);
  const ph = placeholderFieldCount(first);
  return {
    ok: false, blocks: all.length, real: 0,
    why: miss.length ? `结论块缺必填字段（${miss.join('/')}）` : `结论块字段齐全但值仍是占位符（${ph} 处）`,
    detail: first.slice(0, 160).replace(/\n/g, ' '),
  };
}
