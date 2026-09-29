/**
 * runbook 台账解析库（approval-sync / dispatch-metrics / guard-audit / validate 共用）
 *
 * 三件套的表格都是人可读 Markdown，解析必须：
 *  - 只认标记锚点内的表格（<!-- dispatch-log-begin/end -->、<!-- pending-approval-begin/end -->），
 *    防止把文档正文里的竖线当成列；
 *  - 容忍列内换行以外的脏数据（空单元格、尾随空格、`—` 占位）；
 *  - 单号与四态解析失败时显式返回 null，由调用方决定是「跳过」还是「报违规」。
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const RUNBOOK_FILES = {
  dispatch: '派单日志.md',
  pending: '待签批清单.md',
  approval: '审批记录.md',
  evidence: '证据索引.md',
  view: '签批状态视图.md',
  metrics: '度量看板.md',
};
export const MARKERS = {
  dispatch: ['<!-- dispatch-log-begin -->', '<!-- dispatch-log-end -->'],
  pending: ['<!-- pending-approval-begin -->', '<!-- pending-approval-end -->'],
  approval: ['<!-- approval-ledger-begin -->', '<!-- approval-ledger-end -->'],
};

/** 解析一段 Markdown 中所有表格 */
export function parseTables(md) {
  const lines = String(md).split(/\r?\n/);
  const tables = [];
  let cur = null;
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('|') && t.endsWith('|')) { (cur || (cur = [])).push(t); }
    else if (cur) { tables.push(cur); cur = null; }
  }
  if (cur) tables.push(cur);
  return tables.map((table) => {
    const cells = (row) => row.slice(1, -1).split('|').map((c) => c.trim());
    return {
      headers: cells(table[0]),
      rows: table.slice(2).filter((l) => !/^[\s|:-]+$/.test(l)).map(cells),
    };
  });
}

/** 解析一段 Markdown 中第一条表格：返回 { headers, rows }，rows 为单元格数组 */
export function parseTable(md) {
  return parseTables(md)[0] || { headers: [], rows: [] };
}

/** 按表头关键字选表（一个文件里有多张表时用，如审批记录.md 同时有「四态定义」与「签批台账」） */
export function pickTable(md, headerKeyword) {
  const tables = parseTables(md);
  return tables.find((t) => t.headers.some((h) => h.includes(headerKeyword))) || tables[0] || { headers: [], rows: [] };
}

/** 取标记锚点内的表格；锚点缺失时按表头关键字回退（兼容无锚点的旧文件） */
export function parseAnchored(md, kind, headerKeyword) {
  const m = MARKERS[kind];
  const anchored = m && String(md).includes(m[0]) && String(md).includes(m[1])
    ? String(md).split(m[0])[1].split(m[1])[0]
    : null;
  if (anchored) return parseTable(anchored);
  return headerKeyword ? pickTable(md, headerKeyword) : parseTable(md);
}

/** DSP-YYYYMMDD-HHMM[-NN] / AP-YYYYMMDD-HHMM[-NN] → { id, kind, ymd, hm, seq } */
export function parseSerial(cell) {
  const m = /^\s*(DSP|AP)-(\d{8})-(\d{4})(?:-(\d{2}))?\s*$/.exec(String(cell || ''));
  if (!m) return null;
  const [, kind, ymd, hm, seq] = m;
  return {
    id: `${kind}-${ymd}-${hm}${seq ? `-${seq}` : ''}`,
    kind, ymd, hm, seq: seq || null,
    iso: `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)} ${hm.slice(0, 2)}:${hm.slice(2, 4)}`,
  };
}

/**
 * 从结论单元格里抽四态与严重度；抽不到就 null（不猜）。
 * 顺序至关重要：必须**先判「有条件」再判「批准」**——否则「有条件批准」会被
 * /建议批准|批准/ 抢先匹配成「批准」，把人类的有条件签批误记为无条件批准，
 * 污染采纳率与审计链（2026-09-27 真实派单 DSP-20260927-0020-02 由 expert/20-docs 查出）。
 */
export function classifyVerdict(cell) {
  const s = String(cell || '');
  // 更具体的表述优先：先「有条件」，再「驳回/需人工」，最后才是「批准」
  const verdict = /有条件/.test(s) ? '有条件'
    : /驳回|否决/.test(s) ? '驳回'
      : /需人工|升级/.test(s) ? '需人工'
        : /建议批准|批准/.test(s) ? '批准' : null;
  // 严重度：台账实际写法是「四态/严重度」（如「驳回/高」「需人工/高：…」），
  // 即严重度在分隔符**之后**；早期正则只认「高:」这种前置写法，导致严重度长期解析为 null。
  // 这里两个方向都认，并用边界字符避免误判。
  const severity = /高危|阻断/.test(s) ? '高'
    : /[:：/\s（(]高(?:$|[\s)）:：/、，。；;])/.test(s) ? '高'
      : /[:：/\s（(]中(?:$|[\s)）:：/、，。；;])/.test(s) ? '中'
        : /[:：/\s（(]低(?:$|[\s)）:：/、，。；;])/.test(s) ? '低' : null;
  return { verdict, severity, raw: s };
}

export const daysSince = (iso) => (iso ? Math.floor((Date.now() - new Date(iso.replace(' ', 'T')).getTime()) / 86400000) : null);

/**
 * 「这一格**就是**占位符」——不是「这一格**提到**占位符」。
 *
 * ⚠ 这个区分是实测逼出来的。第一版用 /待填|TODO|TBD|待补/ 扫全文，
 *   在**既有**的核对记录上误报了两行：
 *     DSP-20260927-1222-01 处置列：「② 文档同步**待补**」
 *     DSP-20260927-0020-01 专家结论列：「新增待补录04§4.3」
 *   两者都是正常中文。若照第一版写，门禁会对**正确的内容**报红。
 *   ——这是本体系第 4 次栽在「关键词匹配被『只是提到』骗到」上，故必须整格精确匹配。
 *
 * 放在这里而不是各自内联：`crosscheck-seed`（插骨架）、`validate`（拦骨架）、
 * `selftest`（钉行为）三方都要用，**内联两份必然漂移**——而漂移出来的两份里
 * 有一份宽松，就等于那道门形同虚设。
 */
export function isBarePlaceholder(cell) {
  const bare = String(cell || '').replace(/[*\s]/g, '');
  return /^[（(【[]?(待填|待补|待复核|待确认|TODO|TBD)[)）】\]]?$/.test(bare);
}

export async function readRunbook(root) {
  const dir = join(root, 'docs', 'expert-team', 'runbook');
  const out = {};
  for (const [key, file] of Object.entries(RUNBOOK_FILES)) {
    try { out[key] = { file, md: await readFile(join(dir, file), 'utf8') }; } catch { out[key] = { file, md: null }; }
  }
  out.dispatchTable = out.dispatch.md ? parseAnchored(out.dispatch.md, 'dispatch', '派单号') : { headers: [], rows: [] };
  out.pendingTable = out.pending.md ? parseAnchored(out.pending.md, 'pending', '审批单号') : { headers: [], rows: [] };
  out.approvalTable = out.approval.md ? parseAnchored(out.approval.md, 'approval', '审批单号') : { headers: [], rows: [] };
  return out;
}

/** 派单日志 → 结构化记录 */
export function dispatchRecords(book) {
  return book.dispatchTable.rows.map((r, i) => {
    const serial = parseSerial(r[0]);
    return {
      line: i + 1, dsp: serial, time: r[1] || '', subject: r[2] || '', humanA: r[3] || '',
      R: r[4] || '', C: r[5] || '', dispatched: r[6] || '',
      ...classifyVerdict(r[7]), needSign: /Y/i.test(r[8] || '') ? 'Y' : (/N/i.test(r[8] || '') ? 'N' : null),
    };
  });
}

/** 待签批清单 → 结构化记录 */
export function pendingRecords(book) {
  return book.pendingTable.rows.map((r, i) => {
    const serial = parseSerial(r[0]);
    return {
      line: i + 1, ap: serial, dsp: parseSerial(r[1]), subject: r[2] || '', humanA: r[3] || '',
      ...classifyVerdict(r[4]), rc: r[5] || '', risk: r[6] || '', status: r[7] || '', note: r[8] || '',
      open: /待签批/.test(r[7] || ''),
    };
  });
}

/** 审批记录台账 → 结构化记录（列序：审批单号|审批日期|签批时间|事项摘要|关联派单号|人类A|R|C|专家建议|签批结论|依据|会签|证据） */
export function approvalRecords(book) {
  return book.approvalTable.rows.map((r, i) => {
    const serial = parseSerial(r[0]);
    return {
      line: i + 1, ap: serial,
      date: r[1] || '', signedAt: r[2] || '',
      subject: r[3] || '', dsp: parseSerial(r[4]),
      humanA: r[5] || '', R: r[6] || '', C: r[7] || '',
      suggestion: classifyVerdict(r[8]).raw, conclusion: classifyVerdict(r[9]).verdict,
      basis: r[10] || '', countersign: r[11] || '', evidence: r[12] || '',
    };
  });
}

/**
 * 从派单日志某行的「事项摘要」里抽出它评审过的 commit hash（短 hash，通常 8 位）。
 * 只收**含 a–f 字母**的十六进制串：纯数字的 8 位串（例如日期 20260928）不是 hash。
 */
export function commitHashesIn(subject) {
  const s = String(subject || '');
  const out = new Set();
  for (const m of s.matchAll(/\b([0-9a-f]{7,40})\b/g)) {
    if (/[a-f]/.test(m[1])) out.add(m[1].toLowerCase());
  }
  return [...out];
}

/**
 * 该 commit 是否已有**已签批的评审记录**（幂等终态判据的核心）。
 *
 * 为什么需要它（2026-09-28 实测事故）：
 *   fail-closed 门是「有结论 且 有留痕」才推进 lastHead。router 遇到已评审过的 commit 会
 *   **正确地拒绝重复评审**——它写了派单日志行（留痕=true）但**不产出结论块**
 *   （结论=false，因为确实没什么新可评）。于是门把它判成失败 → 不推进基线 →
 *   同一个 commit 下一轮又进窗口 → 无限重派。
 *   实测 `6e9416c5` 被派 **30 次**（17:48–22:54），每 ~6 分钟一轮，
 *   并把**同一个 commit 排了 5 次待签批**——等于要人类把同一件事签 5 遍。
 *
 * 为什么判据要**从台账取证**而不是看 router 说了什么：
 *   「幂等去重 / 不重复派单 / 结论沿用」都是 router 的自然语言表达，
 *   本体系已经栽在「关键词匹配被『只是提到』骗到」上 **4 次**，不栽第 5 次。
 *   台账侧的事实是硬的：**存在一行 需签批=Y 的派单，且它对应的 AP 已在审批台账里有签批结论**。
 *
 * ⚠ 这条判据**不会让未评审的提交蒙混过关**：链路的最后一环是**人类的签字**。
 *   只要该 commit 还没有一份被人类签过的评审，signed 仍为 false，门继续 fail-closed。
 *   即：**幂等跳过要等到「这份评审已被人类签批」之后才算终态**，
 *   避免「router 说跳过所以跳过」变成绕过评审的后门。
 */
export function hasSignedReview(commitHash, { dispatchTable, approvalTable } = {}) {
  const h = String(commitHash || '').toLowerCase();
  if (!h) return { signed: false, why: '无 commit hash' };
  const approvals = new Set((approvalTable && approvalTable.rows || [])
    .map((r) => String(r[0] || '').trim()).filter(Boolean));
  for (const r of (dispatchTable && dispatchTable.rows || [])) {
    if (!/^\s*Y\s*$/i.test(String(r[8] || ''))) continue;
    const hashes = commitHashesIn(r[2]);
    if (!hashes.some((x) => h.startsWith(x) || x.startsWith(h))) continue;
    const ap = String(r[0] || '').trim().replace(/^DSP-/, 'AP-');
    if (approvals.has(ap)) {
      return { signed: true, why: `${String(r[0]).trim()} 标记需签批=Y，且 ${ap} 已在审批台账有签批结论` };
    }
  }
  return { signed: false, why: '无「需签批=Y 且已被人类签批」的评审记录' };
}


/**
 * 统计「同一 commit 被反复排入待签批队列」（validate 第 19 节的判据，2026-09-29）
 *
 * ── 为什么抽成独立纯函数 ───────────────────────────────────────────────
 * 初版我把这个统计**内联在 `validate-expert-team.mjs` 里**，结果 selftest 根本测不到它——
 * 由 expert/14-qa-governance 在 `DSP-20260929-0047-01` 指出（「§19 统计逻辑未抽取为独立函数
 * 致测试盲区」）。**这是本体系的老形状**：逻辑写在门禁里 ⇒ 只能靠「整份门禁跑一遍」来验证，
 * 而那既慢又无法构造边界情形。**判据逻辑必须住在可单测的地方。**
 *
 * ── 判据为什么是「入队次数」而不是「总派单次数」────────────────────────
 * 多 commit 批次（「4-commit批次（a,b,c,d）」）会让**每个 commit 各计一次总派单**，
 * 于是正常的一批多提交评审天然就 ≥3——**那不是重复派单，那是批次**。
 * 真正的危害只有一个：**同一份内容被反复塞给人类签字**。故取「需签批=Y 的派单行数」。
 *
 * ── 阈值的来历（不拍脑袋）──────────────────────────────────────────────
 * 实测本台账入队次数分布 `{0:2, 1:30, 2:9, 3:1, 6:1}`，次高值是 3（`363f72ea`，
 * 建体系时同一 seed commit 的三笔种子派单）。**4 把「异常」与「历史最高」清晰隔开。**
 * 代价是「3 次以内不告警」，已在 `06` 写明，不假装覆盖。
 *
 * @param {string[][]} rows 派单行，每行至少含 [派单号, 事项摘要, 需签批]
 * @param {{threshold?:number, known?:Object}} opts
 * @returns {{over:Array, total:Map, queued:Map, rowsSeen:number, queuedMarks:number, needSignParsed:number}}
 */
export function duplicateQueueStats(rows, { threshold = 4, known = {} } = {}) {
  const E = String();
  const total = new Map();
  const queued = new Map();
  let rowsSeen = 0;
  let needSignParsed = 0;

  for (const r of rows || []) {
    const id = String(r[0] || E).trim();
    const subject = String(r[1] || E);
    const need = String(r[2] || E);
    if (!id) continue;
    rowsSeen++;
    // needSign 必须**独立解析**，不能借用 classifyVerdict（那是审四态用的）。
    // 解析不出 Y/N 的行不计入 queuedMarks，自证会用它判「扫描器是否坏了」。
    if (/^\s*Y\s*$/i.test(need)) needSignParsed++;
    for (const h of commitHashesIn(subject)) {
      if (!total.has(h)) { total.set(h, 0); queued.set(h, []); }
      total.set(h, total.get(h) + 1);
      if (/^\s*Y\s*$/i.test(need)) queued.get(h).push(id);
    }
  }

  const over = [...queued.entries()]
    .filter(([, l]) => l.length >= threshold)
    .map(([hash, list]) => ({ hash, list, fresh: !(hash in known), why: known[hash] || E }))
    .sort((a, b) => b.list.length - a.list.length);

  return { over, total, queued, rowsSeen, queuedMarks: needSignParsed, threshold };
}
