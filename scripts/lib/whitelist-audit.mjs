/**
 * 免评审白名单语义审计（2026-09-27）
 *
 * 为什么重写（expert/16-devops-sre 在 DSP-20260927-1207-01 指出「护栏为样本黑名单非语义白名单」——成立）：
 *   旧做法是「列若干禁止类别，每类取**一个样例路径**去试白名单正则，命中即 fail」。
 *   它有两个实测可证的洞：
 *     ① 白名单写 `^scripts/lib/` → 样例是 `scripts/autodispatch-watcher.mjs`，**命中不了**，
 *        于是台账解析库 `scripts/lib/runbook.mjs` 被静默豁免——而它正是门禁的解析实现；
 *     ② 白名单写 `^\.opencode/agents/expert/` → 样例是 `router.md`，**命中不了**，
 *        于是 20 个专家 Agent 定义全部被豁免。
 *   样例是有限的，仓库不是。**只要判定依赖样例，绕过它就不难。**
 *
 * 新做法（正向语义判定，不依赖任何样例）：
 *   对每条白名单模式，在**整个仓库的真实文件树**上展开它实际匹配的所有路径，
 *   再逐个判定该文件是否**可证为机器生成**（内容里声明「自动生成/勿手编辑」）。
 *   判定结果只有三种：
 *     GENERATED —— 文件自证为机器生成 → 允许豁免；
 *     PROTECTED —— 命中审计链或门禁本体（内置硬规则，不依赖样例）→ 判 fail；
 *     UNKNOWN   —— 既非自证生成、也不在硬规则内 → 判 fail（**存疑即拒**）。
 *   外加两条：模式**匹配不到任何文件** → fail（死规则，易被误解为"已豁免全部"）；
 *             匹配到 GENERATED 之外的东西 → 一律 fail。
 *
 * 关键差异：判定的依据是**「这个文件是不是机器生成的」**这个可验证事实，
 * 而不是「它长得像不像我事先想好的那几个」。
 */

export const GENERATED_MARKERS = [/自动生成/, /勿手编辑/, /勿手改/, /auto-?generated/i];

/** 审计链与门禁本体：内置硬规则（不依赖样例），命中即不可豁免 */
export const PROTECTED_RULES = [
  { re: /(^|\/)审批记录\.md$/, why: '人类签批台账本身' },
  { re: /(^|\/)派单日志\.md$/, why: '派单审计留痕' },
  { re: /(^|\/)待签批清单\.md$/, why: '待签批队列' },
  { re: /(^|\/)核对记录\.md$/, why: '双方核对台账' },
  { re: /(^|\/)免评审白名单\.csv$/, why: '白名单自身（豁免口子的定义处）' },
  { re: /^scripts\/lib\//, why: '台账解析库（门禁实现的一部分）' },
  { re: /^scripts\//, why: '门禁执行代码' },
  { re: /^\.github\/workflows\//, why: 'CI 流水线' },
  { re: /^\.opencode\/agents\//, why: 'Agent 协议与专家定义' },
  { re: /raci\/RACI矩阵\.csv$/, why: 'RACI 唯一事实源' },
  { re: /raci\/门禁阈值\.csv$/, why: '门禁阈值唯一事实源' },
  { re: /raci\/路径路由规则\.csv$/, why: '路径路由规则表' },
  { re: /raci\/免评审白名单\.csv$/, why: '免评审白名单自身' },
  { re: /^\.github\//, why: 'CI 配置目录（不得整体豁免）' },
  { re: /04-编排与门禁\.md$/, why: '编排与门禁主文档' },
  { re: /01-统一Agent骨架\.md$/, why: '结论块契约' },
  { re: /06-门禁阈值与判定口径\.md$/, why: '门禁口径权威文档' },
];

export const KIND = { GENERATED: 'GENERATED', PROTECTED: 'PROTECTED', UNKNOWN: 'UNKNOWN' };

/** 判定单个文件：优先 PROTECTED（防"文件自称生成"来绕过），再看是否自证生成 */
export function classifyPath(path, headText) {
  for (const r of PROTECTED_RULES) {
    if (r.re.test(path)) return { kind: KIND.PROTECTED, why: r.why };
  }
  const text = String(headText || '').slice(0, 400);
  for (const m of GENERATED_MARKERS) {
    if (m.test(text)) return { kind: KIND.GENERATED, why: `文件自证为机器生成（命中 ${m}）` };
  }
  return { kind: KIND.UNKNOWN, why: '既非机器生成、也不在硬规则内——存疑即拒' };
}

/**
 * 审计白名单。
 *
 * ⚠ `headOf` 必须是**同步**函数或返回字符串——我第一版把它写成 async 并直接把
 *   返回的 Promise 传给同步的 classifyPath，于是 `String(Promise)` === "[object Promise]"，
 *   三个派生视图全被判成「无法证明为机器生成」。**类型层面的错，文本断言抓不到**，
 *   故下面刻意做成 async 并 await，消灭这类隐患。
 *
 * @param {string} csv 白名单内容（含表头）
 * @param {string[]} repoFiles 仓库内所有文件相对路径
 * @param {(p:string)=>string|Promise<string>} headOf 读取文件开头若干字符
 */
export async function auditWhitelist(csv, repoFiles, headOf) {
  const rows = String(csv || '').replace(/^\uFEFF/, '').trim().split(/\r?\n/).slice(1)
    .map((l) => ({ pat: (l.split(',')[0] || '').trim(), raw: l }))
    .filter((r) => r.pat);
  const rules = [];
  const issues = [];
  if (!rows.length) issues.push({ level: 'fail', msg: '白名单为空——空表易被误读为「都可以豁免」，若确实无豁免项请删表' });

  for (const r of rows) {
    let re = null;
    try { re = new RegExp(r.pat, 'i'); } catch {
      issues.push({ level: 'fail', msg: `白名单正则写错无法编译: ${r.pat}` });
      rules.push({ ...r, matched: [], gen: [], verdict: 'INVALID' });
      continue;
    }
    const matched = (repoFiles || []).filter((p) => re.test(p));
    // 逐个 await 取文件头——同步/异步 headOf 都支持，杜绝 Promise 被当字符串用
    const kinds = [];
    for (const p of matched) {
      let head = '';
      try { head = (headOf ? await headOf(p) : '') || ''; }
      catch { head = ''; }
      if (typeof head !== 'string') head = '';   // 兜底：非字符串一律视为读不到
      kinds.push({ path: p, ...classifyPath(p, head) });
    }
    const prot = kinds.filter((k) => k.kind === KIND.PROTECTED);
    const unk = kinds.filter((k) => k.kind === KIND.UNKNOWN);
    const gen = kinds.filter((k) => k.kind === KIND.GENERATED);
    let verdict = 'OK';
    if (!matched.length) {
      verdict = 'DEAD';
      issues.push({ level: 'fail', msg: `白名单规则匹配不到任何文件（死规则，易被误解为已豁免全部）: ${r.pat}` });
    } else if (prot.length) {
      verdict = 'PROTECTED';
      for (const k of prot) issues.push({ level: 'fail', msg: `白名单豁免了受保护文件「${k.why}」：${r.pat} → 实际匹配 ${k.path}` });
    } else if (unk.length) {
      verdict = 'UNKNOWN';
      for (const k of unk) issues.push({ level: 'fail', msg: `白名单豁免了无法证明为机器生成的文件（存疑即拒）：${r.pat} → ${k.path}（${k.why}）` });
    }
    rules.push({ ...r, matched, gen: gen.map((x) => x.path), verdict });
  }
  return { rules, issues, ok: issues.every((i) => i.level !== 'fail') };
}
