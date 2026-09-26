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
