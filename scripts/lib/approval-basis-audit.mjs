/**
 * 审批台账「决策依据」与台账现状的**矛盾**审计
 *
 * ── 为什么做这件事 ───────────────────────────────────────────────────────
 * 2026-09-28，expert/20-docs 在 `DSP-20260928-1530-01` 里抓出：人类签批台账
 * `AP-20260928-1228-01` 的决策依据写着
 *   「③『待签批清单未回填 + 状态视图滞后』→ 已重跑 approval-sync / dispatch-metrics 刷新。
 *     **条件既已满足，故落批准**」
 * 而经核实：当时只重跑了那两个脚本，而**它们根本不写待签批清单的状态列**，
 * 该行状态当时仍是「待签批」。**条件并未满足。**
 *
 * 这是本体系第一次出现**写在人类签批台账上的不成立陈述**，而且当时无人发现。
 * 根因不是有人撒谎，而是**没有任何机制把「依据里的断言」和「台账的实际状态」对照**。
 *
 * ── 这个模块能做什么、不能做什么（边界，务必读完）──────────────────────
 * 能：查出**机械可判定的自相矛盾**——依据里断言「条件已满足 / 视图已刷新」，
 *      而台账里能证明它不成立。
 * 不能：**证明依据为真**。一段依据里绝大多数内容（为什么这样判、引用了哪次取证）
 *      是无法机械验证的推理，那仍然只能靠人或专家评审。
 *
 *   所以准确的说法是：本模块**减少假话的空间**，不是**杜绝假话**。
 *   任何文档都不得把它写成「审批依据已自动核实」——那是又一个不成立的陈述。
 *
 * ── 两条判据 ───────────────────────────────────────────────────────────
 * A. 「条件已满足」 vs 队列状态：依据里有「完成断言」子句，而该单在待签批清单里
 *    **仍写着「待签批」** → 矛盾。
 *    这条正是 1228-01 那句假话当时会被抓到的原因。
 * B. 「已刷新视图」 vs 视图新鲜度：依据里点名了某个派生视图并声称已刷新，
 *    而该视图的生成时间**早于签批日**（按天比较，见下） → 矛盾。
 *
 * ── 两个必须写明的技术边界 ───────────────────────────────────────────────
 * 1. **时区**：`签批状态视图.md` 的生成时间由 `toISOString()` 产生，是 **UTC**；
 *    而签批时间是人类手填的**本地时间**。本模块**只按天比较并留 ±1 天容差**，
 *    绝不按分钟/秒比。理由：本体系已经因为混比 UTC 与本地时间吃过亏
 *    （`logs/watcher.log` 记 UTC、派单号里的 HHMM 是本地），按分钟比必然产生假阴性。
 *    代价是查不出「同一天内的虚假刷新」——如实记下，不假装覆盖。
 * 2. **只做矛盾检测，不做真伪判定**：判据的每一条都是「断言 X」与「事实非 X」的**合取**，
 *    命中即矛盾；不命中**不代表断言为真**。绿灯的含义是「未发现矛盾」，仅此而已。
 */

/** 派生产物 → 文件名（含「生成时间」的只有前两个）。用于判据 B。 */
export const VIEW_FILES = ['签批状态视图.md', '度量看板.md'];

/**
 * 脚本 → 它写出的文件。
 *
 * ⚠ 判据 B 必须按**脚本名**匹配，不能只认视图名：真实的那句假话写的是
 *   「已重跑 `approval-sync` / `dispatch-metrics` 刷新」——**通篇没出现「状态视图」四个字**。
 *   我第一版只按视图名找，结果对 1228-01 完全无效（反向测试实测：早 8 天却不报）。
 *   这就是「匹配实体必须用可证方式」的又一处：按人实际会写的那个词去匹配。
 *
 * ⚠ 映射到**文件名**而不是视图别名。我第二版用别名（`签批状态视图` / `状态视图`），
 *   而这两个别名指向同一个文件，于是同一次过期被判成 **2 条**违规——计数虚高一倍，
 *   而门禁的计数是要给人看的，噪声会让人忽略真信号。
 *
 * 只列**带生成时间戳**的产物：`待签批清单.md` 的状态列没有时间戳（它是就地回填的），
 *   拿「文件 mtime」去比签批时间会得到无意义的结论，故不纳入。如实记下这个边界。
 */
export const PRODUCERS = {
  'approval-sync': ['签批状态视图.md'],
  'dispatch-metrics': ['度量看板.md'],
};

/** 完成断言：必须与「条件/前提」同现才算数，单独出现不触发（避免把「已修复 X」误判成条件已满足） */
const COMPLETE = /(?:条件|前提|条件项|两项|三项)[^。；;]{0,24}?(?:已|均已|皆已)?\s*(?:满足|达成|闭环|清零|已清|解决|具备|就绪)/;
/** 只重跑/刷新/生成 类动作声明（不含结论） */
const REFRESH_CLAIM = /(?:已重跑|重跑后|已刷新|已重新生成|已跑)/;

/**
 * 「在引述里」与「在否定/更正里」——这两种子句都**不是**在陈述事实。
 *
 * 为什么用**引号判定**而不是纯否定词黑名单：
 *   2026-09-28 反向测试实测，1228-01 的**更正子句**里写着
 *     「…但「条件既已满足」**不属实**」
 *   它引述了那句假话并明确否认它，却仍被判成矛盾——**假阳性**。
 *   补否定词（「不属实」「并非」…）能压住这一例，但那是继续往黑名单里加词，
 *   而本体系记录过三次「关键词匹配被『只是提到』骗到」的事故。
 *   改为**正向判定**：完成短语若落在引号内，就是在**引用**它，不是在**主张**它。
 *   这一条不依赖词表，且对任何新写法都成立。
 */
const QUOTED = /[「『“"'']/;
const DENY = /(?:并未|未满足|不满足|不成立|不属实|并非|不是事实|是假|假的|虚假|质疑|已作废|作废|更正为|其实不|实际上不|所谓)/;

/** 引号是否**包住**了命中处：只看命中位置之前最近的引号与之后最近的引号，谁更近算谁的 */
function completionIsQuoted(clause, m) {
  const before = clause.slice(0, m.index);
  const after = clause.slice(m.index);
  const openNear = Math.max(before.lastIndexOf('「'), before.lastIndexOf('『'), before.lastIndexOf('“'), before.lastIndexOf('"'));
  const closeNear = Math.min(...['」', '』', '”', '"'].map((q) => {
    const i = after.indexOf(q);
    return i < 0 ? Infinity : i;
  }));
  return openNear >= 0 && closeNear < after.length && closeNear > -1;
}

/** 把一格拆成子句。子句才是语义单元——固定字符距离窗口漏报过 61 字的情形。 */
export function splitClauses(text) {
  const s = String(text || '');
  // 先按句号/分号/换行断，再按带圈序号断；保留序号以便定位
  const parts = [];
  let cur = '';
  for (const ch of s) {
    cur += ch;
    if ('。；;\n'.includes(ch)) { parts.push(cur); cur = ''; }
  }
  if (cur.trim()) parts.push(cur);
  const out = [];
  for (const p of parts) {
    const seg = p.split(/(?=[①②③④⑤])/);
    for (const t of seg) if (t.trim()) out.push(t.trim());
  }
  return out;
}

/** 从派生视图正文里抽生成时间（UTC，形如 `2026-09-28 08:57:32`）。抽不到返回 null。 */
export function viewGeneratedAt(md) {
  const m = /生成时间[：:]\s*(\d{4}-\d{2}-\d{2})/.exec(String(md || ''));
  return m ? m[1] : null;
}

/** 只按天比较，返回 >0 表示视图比签批日早多少天（负=更新，0=同一天） */
export function daysStale(viewDay, signDay) {
  if (!viewDay || !signDay) return null;
  const a = Date.parse(viewDay + 'T00:00:00Z');
  const b = Date.parse(signDay + 'T00:00:00Z');
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

/**
 * @param {object} p
 * @param {Array<{ap:string, basis:string, signDay:string}>} p.approvals 审批台账行
 * @param {Map<string,string>} p.queueStatus 审批单号 → 待签批清单的状态列原文
 * @param {Map<string,string>} p.viewDays   视图别名 → 生成日期(YYYY-MM-DD, UTC)
 * @returns {{violations:Array, inspected:number, clausesScanned:number}}
 */
export function auditApprovalBasis({ approvals = [], queueStatus = new Map(), viewDays = new Map() } = {}) {
  const violations = [];
  let clausesScanned = 0;

  for (const a of approvals) {
    const clauses = splitClauses(a.basis);
    clausesScanned += clauses.length;
    for (const cl of clauses) {
      if (DENY.test(cl)) continue;                  // 明确否认/更正，不是陈述

      // ── 判据 A ──
      const cm = COMPLETE.exec(cl);
      if (cm) {
        // 命中处在引号内 → 是在**引用**那句断言（例如「…但「条件既已满足」不属实」），
        // 不是在**主张**它。这类子句必须放过，否则更正动作本身会被判成矛盾。
        const quoted = completionIsQuoted(cl, cm);
        const st = queueStatus.get(a.ap);
        if (!quoted && st !== undefined && /待签批/.test(st)) {
          violations.push({
            ap: a.ap, rule: 'A', kind: '条件断言与队列状态矛盾',
            detail: `依据称条件已满足/达成，但待签批清单该行状态仍是「${st}」`,
            clause: cl.slice(0, 120),
          });
        }
      }

      // ── 判据 B：按**脚本名**匹配（真实假话写的是脚本名，不是视图名）──
      if (REFRESH_CLAIM.test(cl)) {
        for (const [script, files] of Object.entries(PRODUCERS)) {
          if (cl.indexOf(script) < 0) continue;
          for (const file of files) {
            const day = viewDays.get(file);
            if (!day) continue;
            const stale = daysStale(day, a.signDay);
            // stale > 1 才是矛盾：±1 天容差用来吸收 UTC/本地时区差（见文件头「技术边界 1」）
            if (stale !== null && stale > 1) {
              violations.push({
                ap: a.ap, rule: 'B', kind: '「已重跑」与产物新鲜度矛盾',
                detail: `依据称已重跑「${script}」，但其产物「${file}」生成于 ${day}，比签批日 ${a.signDay} 早 ${stale} 天`,
                clause: cl.slice(0, 120),
              });
            }
          }
        }
      }
    }
  }
  return { violations, inspected: approvals.length, clausesScanned };
}
