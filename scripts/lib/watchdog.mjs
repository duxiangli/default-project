/**
 * 常驻心跳判定（2026-09-28）
 *
 * 为什么需要它：2026-09-27 23:01 起 watcher 静默死亡约 14 小时，期间——
 *   熔断器报 closed / 0 失败、stderr 无新增、计划任务状态 Ready（不是 Failed）、
 *   CI 全绿、无人察觉。**整个体系的价值都建立在它跑着，而它没有「我是否在跑」的自检。**
 *
 * ⚠ 关键设计约束：**不能只做「超阈值即红」**。
 *   `logs/` 在 .gitignore 里，所以 GitHub Actions（Linux）**根本没有这个日志文件**；
 *   若把「读不到日志」当成「通过」，就是**假保证**——比没有检查更坏，因为它给人虚假安心。
 *   若当成「失败」，CI 又会永久红、从而被无视。
 *   故本模块只出**三态**，由调用方决定各自怎么处理：
 *     FRESH    —— 日志在、最后心跳在阈值内 → 通过；
 *     STALE    —— 日志在、但最后心跳超阈值 → 失败（这才是真问题）；
 *     UNKNOWN  —— 日志不存在 / 无法解析 / 本机并非常驻宿主 → **既不报绿也不报红**，
 *                 必须显式说明「无法评估」及原因。
 *
 * 纯函数、无 IO：便于 selftest 覆盖（不测就会像白名单护栏那样留洞）。
 */

/** 从 watcher.log 文本里解析出最后一行时间戳（格式 `[YYYY-MM-DD HH:mm:ss] ...`） */
export function lastHeartbeat(logText) {
  const lines = String(logText || '').split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})\]/.exec(lines[i].trim());
    if (m) return { at: `${m[1]}T${m[2]}Z`, line: i + 1, text: lines[i].trim().slice(0, 90) };
  }
  return null;
}

export const VERDICT = { FRESH: 'FRESH', STALE: 'STALE', UNKNOWN: 'UNKNOWN' };

/**
 * @param {object} o
 * @param {string|null} o.logText  watcher.log 内容（读不到传 null）
 * @param {boolean} o.residentExpected 本机是否应当有常驻在跑
 * @param {number}  o.maxSilenceSec  允许的最长静默
 * @param {Date}    o.now            当前时间（可注入以便测试）
 * @returns {{verdict:string, reason:string, ageSec:number|null, lastAt:string|null, thresholdSec:number}}
 */
export function judgeHeartbeat({ logText, residentExpected, maxSilenceSec, now = new Date() }) {
  const thresholdSec = Number(maxSilenceSec) || 900;
  if (logText === null || logText === undefined) {
    return {
      verdict: VERDICT.UNKNOWN,
      // 关键：读不到日志时**绝不判绿**。CI 上 logs/ 被 gitignore、没有日志是正常状态，
      // 但那不等于「心跳正常」——把它当通过就是假保证。
      reason: residentExpected
        ? '读不到 logs/watcher.log，但本机声明应有常驻 → 无法评估（**不等于通过**）'
        : '读不到 logs/watcher.log，且本机非常驻宿主（如 CI）→ 不适用',
      ageSec: null, lastAt: null, thresholdSec,
    };
  }
  const hb = lastHeartbeat(logText);
  if (!hb) {
    return {
      verdict: VERDICT.UNKNOWN,
      reason: 'watcher.log 存在但解析不出最后心跳时间 → 无法评估（**不等于通过**）',
      ageSec: null, lastAt: null, thresholdSec,
    };
  }
  const at = new Date(hb.at);
  const ageSec = Math.round((now.getTime() - at.getTime()) / 1000);
  const base = {
    ageSec, lastAt: hb.at, thresholdSec,
    reason: `最后心跳 ${hb.at}（第 ${hb.line} 行），距今 ${Math.round(ageSec / 60)} 分钟，阈值 ${Math.round(thresholdSec / 60)} 分钟`,
  };
  if (ageSec < 0) {
    // 时钟前跳/时区错位：明确报无法评估，不要默默算成「很新鲜」
    return { ...base, verdict: VERDICT.UNKNOWN, reason: base.reason + '；**心跳时间在未来**，疑似时钟/时区错位 → 无法评估' };
  }
  if (ageSec > thresholdSec) {
    return {
      ...base,
      verdict: VERDICT.STALE,
      reason: base.reason + (residentExpected
        ? '　→ **常驻疑似已停**，需人工重启（Stop-ScheduledTask → 杀残留 node → Start-ScheduledTask）'
        : '　→ 超过阈值'),
    };
  }
  // 心跳「新鲜」但本机**不应当**有常驻在跑——这只可能是读到了一份**冻结的历史日志**
  // （例如有人把 logs/ 提交上去，CI 每次都看到同一份旧心跳）。
  // 若照直报 FRESH，就是变相的假绿——和「读不到日志却当通过」同一类错误。
  if (!residentExpected) {
    return {
      ...base,
      verdict: VERDICT.UNKNOWN,
      reason: base.reason + '；但本机**不声明有常驻**（如 CI）——读到新鲜心跳只说明存在一份日志文件，'
        + '不代表此刻有常驻在跑，故不判通过（防「冻结日志」假绿）',
    };
  }
  return { ...base, verdict: VERDICT.FRESH };
}

/**
 * 阈值必须大于轮询间隔，否则正常间隔也会被判 STALE（误报）。
 * 取 max(给定值, 间隔×3 + 60s)：留 3 个周期的余量。
 */
export function resolveThreshold(maxSilenceSec, intervalSec) {
  const i = Number(intervalSec) || 120;
  const given = Number(maxSilenceSec) || 0;
  return Math.max(given, i * 3 + 60);
}
