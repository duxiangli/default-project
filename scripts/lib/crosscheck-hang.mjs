/**
 * 核对记录「挂账纪律」判定（纯函数，2026-09-28）
 *
 * 事故实况：核对记录里有 7 条写着「未修 / 挂账未修 / 如实挂账」，而这些事**早已完成**——
 * 字段值验证（selftest §24.7）、fail-closed 门、冒烟改真跑常驻、降级分支行为测试、
 * 导出脚本假原文…我自己差点信了这条谎话。
 * 原因：体系校验（validate）查节数、脚本清单、术语、白名单，却从不看「处置」列说的是真是假。
 *
 * 判据：处置列按**子句**（以「；」分隔）切分，凡含「未修/挂账」的子句，其自身必须带 ✅。
 * 子句才是语义单元——一个子句里既说「已闭环」又说「挂账」，本身就是矛盾，
 * 不需要看字符距离。（我曾用 30 字与 ±24 字两个固定窗口，均漏报：
 *  1256-01 的 ✅ 与「挂账」相距 61 字。）
 *
 * ⚠ 诚实边界：本函数**不能**判断「已闭环」是否真的闭环了，那需要人读。
 * 它只保证不存在「既挂着未修字样、又没有任何闭环标记」的中间态。
 * **谎称已闭环它抓不到** —— 那要靠人核 commit 是否真在 git 历史里。
 */

/** 处置列在 `line.split('|').slice(1,-1)` 之后的索引（第 7 个数据列） */
export const DISP_COL = 6;

const OPEN_WORD = /未修|挂账/;
const CLOSED_MARK = /\u2705/;

/**
 * 判定前先抹掉两类**「在给这个检查命名」而不是「在声明一项未闭环」的用法**：
 *   「挂账纪律」「挂账项」——例如「① 已完成并复验：第 17 节挂账纪律上线，且经反向测试证明能抓出违规」。
 *   这类子句里出现「挂账」二字，但**没有任何未闭环的断言**，判它未闭环是误报。
 *
 * 为什么是精确列举而不是放宽规则：放宽会让真未闭环漏出。
 * 为什么必须处理它：守卫上线当天就因为我自己写的说明里出现「挂账纪律」而误报——
 * 与我此前 `isVoid = /作废/` 被行文骗过是**同一类错误**：
 * **关键词匹配会被「只是提到」骗到。**
 */
const MENTION_ONLY = /挂账(?:纪律|项)/g;
const normalize = (s) => String(s || '').replace(MENTION_ONLY, '〈本节自身名称〉');

export function openHangClauses(disp) {
  return normalize(disp)
    .split('；')
    .map((c) => c.trim())
    .filter((c) => OPEN_WORD.test(c) && !CLOSED_MARK.test(c));
}

/**
 * **自相矛盾**子句：同一个子句里既说「已闭环」又说「未修/挂账」。
 *
 * 为什么单列一类而不是按「✅ 优先」放过：2026-09-28 实测的 1256-01 就是
 * 「✅已闭环（…；闭环于 3ee5abb**，挂账」——虽然那里 ✅ 与「挂账」被 `；` 分成了两句，
 * 但同子句内出现这种组合同样是矛盾（多半是上一轮整段替换留下了残字）。
 * 放过它 = 让矛盾静默存在，而矛盾正是本节要消灭的东西。
 */
export function contradictoryClauses(disp) {
  return normalize(disp)
    .split('；')
    .map((c) => c.trim())
    .filter((c) => OPEN_WORD.test(c) && CLOSED_MARK.test(c));
}

/**
 * @param {string} text 核对记录.md 全文
 * @returns {{rows:number, hangCount:number, issues:string[], contradictions:string[]}}
 */
export function auditHangRows(text) {
  const issues = [];
  const contradictions = [];
  let rows = 0, hangCount = 0;
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.startsWith('| DSP-')) continue;
    rows++;
    const cc = line.split('|').slice(1, -1);
    const disp = cc[DISP_COL] || '';
    const id = (cc[0] || '').trim();
    for (const clause of openHangClauses(disp)) {
      hangCount++;
      issues.push(`${id}：${clause}`);
    }
    for (const clause of contradictoryClauses(disp)) {
      contradictions.push(`${id}：${clause}`);
    }
  }
  return { rows, hangCount, issues, contradictions };
}
