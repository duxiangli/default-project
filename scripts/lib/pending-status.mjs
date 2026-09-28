/**
 * 待签批清单「状态」列的派生逻辑（approval-sync 调用；纯函数，便于 selftest 覆盖）
 *
 * ── 为什么需要它 ─────────────────────────────────────────────────────────
 * 这一列以前**纯靠人工回填**，而 `approval-sync` 从来不写它（它只 `readRunbook` 读这份
 * 文件来算 open/closed，写目标只有签批状态视图与度量看板）。后果实测过两次：
 *   ① `AP-20260928-1228-01` 的决策依据写「已重跑 approval-sync/dispatch-metrics 刷新，
 *      **条件既已满足**」——实际那两个脚本**根本不写状态列**，条件并未满足。
 *      这句话当时就在人类签批台账上，且**没人发现**，直到 expert/20-docs 在
 *      `DSP-20260928-1530-01` 里抓出来。
 *   ② 于是每次签批都要多一道**纯抄写**的人工步骤，抄漏了没有任何检查会响。
 *
 * ── 边界（重要，别越界）──────────────────────────────────────────────────
 * · 本模块**不做任何签批决定**。结论与日期的**唯一权威来源是人类写的审批记录台账**，
 *   本模块只做「把人类已经写下的东西抄到队列的状态列上」这一件机械事。
 * · **不新增、不删除、不重排行**——只改状态这一个单元格。
 * · 抄不出来就**不抄并报错**，绝不猜、绝不填占位符、绝不写「未知」。
 *   （这与本体系一贯的 fail-closed 方向一致：宁可红，不要看起来对。）
 *
 * ── 为什么不直接用现成的 parseAnchored ───────────────────────────────────
 * 因为要**写回**。解析器只认「整行以 | 开头且以 | 结尾」，但写回必须知道该行在原文中的
 * 绝对位置；而且**单元格内出现裸竖线会让 split('|') 错位**——本轮已在核对记录上踩过
 * 一次（一个格被劈成两半）。所以这里自己按锚点区间逐行处理，并对列数不符**直接中止**。
 */

/** 签批结论的合法取值。抄不出来的行会被跳过并报错，绝不猜。 */
const CONCLUSION_OK = /^(建议批准|有条件批准|有条件通过|有条件|批准|驳回|否决|需人工|升级)$/;
const DATE_OK = /^\d{4}-\d{2}-\d{2}$/;
const OPEN_MARK = /待签批/;

/**
 * 人类四态里「已签批」的写法：已签批·<结论>（<日期>）
 * 选这个格式的理由：审批单号就是该行第 1 列，写进状态列是冗余；
 * 结论与日期的权威值只在审批台账里，派生过来可省一次跨文件查证。
 */
export function statusTextFor(approval) {
  if (!approval) return null;
  const conclusion = String(approval.rawConclusion || '').trim();
  const date = String(approval.date || '').trim();
  if (!CONCLUSION_OK.test(conclusion)) return null;
  if (!DATE_OK.test(date)) return null;
  return `已签批·${conclusion}（${date}）`;
}

/**
 * 算出待签批清单需要改哪些行。
 * @param {{headers:string[], rows:string[][]}} pendingTable  待签批清单的表（列序见下）
 * @param {Map<string,object>} approvalByAp                  审批单号 → 审批记录
 * @returns {{changes:Array, problems:Array, inspected:number}}
 */
export function planPendingStatus(pendingTable, approvalByAp) {
  const headers = pendingTable.headers || [];
  // 索引按**表头名**定位，不写死数字——写死过一次，读到的是隔壁列，
  // 于是得出「0 处需要改」这种**看起来合理的假零**。
  const iAp = headers.findIndex((h) => h.indexOf('审批单号') >= 0);
  const iDsp = headers.findIndex((h) => h.indexOf('关联派单') >= 0);
  const iStatus = headers.findIndex((h) => h.indexOf('状态') >= 0);
  if (iAp < 0 || iDsp < 0 || iStatus < 0) {
    return { changes: [], problems: [{ ap: null, why: `表头缺列（审批单号=${iAp} 关联派单=${iDsp} 状态=${iStatus}）` }], inspected: 0 };
  }

  const changes = [];
  const problems = [];
  const seen = new Set();

  // ── 第 1 趟：全量查重 ──
  // 必须**先扫完整张表**再动手。原实现边走边加 seen，撞到重复时只 push 一条 problem 就
  // `continue`，于是**第一行早已产出了一条 change**——真去改就会改到其中一行，
  // 而另一行留在「待签批」。反向测试实测到这个：problems=1 却 changes=1。
  // 「报了问题但仍然改了东西」比「什么都不改」更坏：台账看起来是处理过的。
  const dup = new Set();
  for (const row of pendingTable.rows || []) {
    const ap = String(row[iAp] || '').trim();
    if (!ap) continue;
    if (seen.has(ap)) dup.add(ap);
    seen.add(ap);
  }
  for (const ap of dup) problems.push({ ap, why: '待签批清单里同一审批单号出现多行，本单**一律不改**（不猜改哪一行）' });

  // ── 第 2 趟：只对「无重复」的单号产出改动 ──
  for (const row of pendingTable.rows || []) {
    const ap = String(row[iAp] || '').trim();
    if (!ap) continue;
    if (dup.has(ap)) continue;

    const approval = approvalByAp.get(ap) || null;
    if (!approval) continue;                      // 还没签批 → 状态就该是「待签批」，不是问题
    if (OPEN_MARK.test(row[iStatus] || '') === false) {
      // 已经写过了，但仍要核对关联派单号是否对得上（错配会让审计链指向错误的派单）
      const dspRow = String(row[iDsp] || '').trim();
      if (approval.dspId && dspRow && dspRow !== approval.dspId) {
        problems.push({ ap, why: `关联派单号与审批台账不一致（清单=${dspRow} 台账=${approval.dspId}），不覆盖` });
      }
      continue;
    }

    const want = statusTextFor(approval);
    if (!want) {
      problems.push({ ap, why: `审批台账里该单的结论或日期不可用（结论=「${approval.rawConclusion}」日期=「${approval.date}」），不抄` });
      continue;
    }
    if (approval.dspId && String(row[iDsp] || '').trim() !== approval.dspId) {
      problems.push({ ap, why: `关联派单号与审批台账不一致（清单=${String(row[iDsp] || '').trim()} 台账=${approval.dspId}），不抄` });
      continue;
    }
    changes.push({ ap, from: row[iStatus], to: want });
  }
  return { changes, problems, inspected: seen.size };
}

/**
 * 把 changes 落到原文行上。**只改状态那一格**，行数、列数、行序一律不动。
 * 遇到下列情况直接抛错，不做「尽力而为」的修补：
 *   · 锚点缺失或不配对
 *   · 目标行找不到 / 找到多行
 *   · 该行切分出的列数与表头不符（含**格内裸竖线**导致的错位）
 */
export function applyPendingStatus(md, pendingTable, changes) {
  const lines = String(md).split(/\r?\n/);
  const [begin, end] = ['<!-- pending-approval-begin -->', '<!-- pending-approval-end -->'];
  const bAt = lines.findIndex((l) => l.includes(begin));
  const eAt = lines.findIndex((l) => l.includes(end));
  if (bAt < 0 || eAt < 0 || eAt <= bAt) throw new Error('待签批清单的锚点缺失或不配对，拒绝改写');
  if (!changes.length) return { md: String(md), applied: 0 };

  const headers = pendingTable.headers || [];
  const iStatus = headers.findIndex((h) => h.indexOf('状态') >= 0);
  const iAp = headers.findIndex((h) => h.indexOf('审批单号') >= 0);
  if (iStatus < 0 || iAp < 0) throw new Error('表头缺列，拒绝改写');

  // 表头行必须在锚点之后第一行附近；先定位它，才能可靠地按列宽解析数据行
  let hAt = -1;
  for (let i = bAt; i < eAt; i++) {
    const t = lines[i].trim();
    if (t.startsWith('|') && t.includes('审批单号') && t.includes('状态')) { hAt = i; break; }
  }
  if (hAt < 0) throw new Error('锚点内未找到表头行，拒绝改写');

  let applied = 0;
  for (const ch of changes) {
    const target = `| ${ch.ap} `;
    const hits = [];
    for (let i = hAt + 1; i < eAt; i++) if (lines[i].startsWith(target)) hits.push(i);
    if (hits.length !== 1) throw new Error(`${ch.ap} 在锚点内匹配到 ${hits.length} 行（应为 1），拒绝改写`);

    const at = hits[0];
    const cells = lines[at].split('|');
    if (cells.length !== headers.length + 2) {
      throw new Error(`${ch.ap} 切分出 ${cells.length} 段、表头 ${headers.length} 列（含首尾空）——`
        + '**多半是某个格里有裸竖线**，拒绝改写（不猜哪一列是哪个）');
    }
    const curStatus = (cells[iStatus + 1] || '').trim();
    if (curStatus !== ch.from) {
      throw new Error(`${ch.ap} 的状态列与计划不符（现=「${curStatus}」计划旧值=「${ch.from}」），拒绝改写`);
    }
    if (ch.to.indexOf('|') >= 0) throw new Error(`${ch.ap} 的目标状态含裸竖线，会切列，拒绝写入`);
    cells[iStatus + 1] = ' ' + ch.to + ' ';
    const rebuilt = cells.join('|');
    if (rebuilt.split('|').length !== headers.length + 2) throw new Error(`${ch.ap} 改写后列数变了`);
    if (!rebuilt.startsWith(target)) throw new Error(`${ch.ap} 行首被改坏`);
    lines[at] = rebuilt;
    applied++;
  }
  return { md: lines.join('\n'), applied };
}
