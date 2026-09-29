/**
 * 把「任意形态的错误」提取成**可诊断的一行文本**。
 *
 * ── 为什么要有（2026-09-29）───────────────────────────────────────────────
 * 实测 `logs/watcher.log` 里连续多轮出现：
 *
 *     [!] 运行期报错: [object Object]
 *
 * **这一行完全无法诊断**——它只告诉你「出错了」，不告诉你「错在哪」。
 * 根因在 `autodispatch-watcher.mjs` 的 `parseRunStream`：
 *
 *     errors.push(String(p.error || ev.error || JSON.stringify(ev)).slice(0, 300));
 *
 * 上游 `opencode run --format json` 的错误事件里，`ev.error` 是一个**结构化对象**，
 * `String(obj)` 恒等于 `"[object Object]"`。
 * 而 `JSON.stringify(ev)` 只在 `p.error` 与 `ev.error` **都为 falsy** 时才用得上——
 * 于是**只要错误是对象，就必然落进 `String()` 那条路**，结构化信息被整个丢掉。
 *
 * 同样的 `String(e.message || e)` 写法在本文件里另有 3 处（`ledgerDoctor` / `refreshViews` /
 * `healthCheck` 的 catch）：`e` 若不是 `Error` 实例（没有 `.message`），
 * 同样退化成 `[object Object]`。**同一类错，四个地方。**
 *
 * ── 提取顺序（**按可靠性排序**，不是按猜测）────────────────────────────
 * 1. 字符串 → 原样（去首尾空白）
 * 2. `Error` 实例 → `name: message`
 * 3. 对象 → 依次探测常见字段：`message` / `msg` / `error` / `reason` / `detail` /
 *    `description` / `data.message` / `data.error`
 * 4. 对象但一个字段都没有 → **退回整段 `JSON.stringify`**（宁可长，也别只留 `[object Object]`）
 * 5. 其他（数字/布尔/null/undefined）→ `String(v)`
 *
 * 第 4 条是本模块的关键：**提取失败时必须回落到完整结构，而不是输出一句废话。**
 *
 * ── 绝不吞掉「提取不出」这件事 ─────────────────────────────────────────
 * 若最终文本恰好是 `[object Object]`（即输入是个无可提取字段的裸对象），
 * 返回值会**带上一个显式标记**，让人一眼看出「这里本来有信息但我拿不出来」，
 * 而不是把 `[object Object]` 当成正常文本往下传——**后者会让下游所有日志跟着失去意义。**
 */

/** 常见的错误消息字段，按可靠性排序（越靠前越可能是给人看的文本） */
const MESSAGE_KEYS = ['message', 'msg', 'error', 'reason', 'detail', 'description', 'text', 'title'];

/** 常见的嵌套位置 */
const NESTED_KEYS = ['data', 'error', 'body', 'response', 'result', 'payload'];

function isPlainish(v) {
  return v !== null && typeof v === 'object';
}

/**
 * @param {any} v 任意形态的错误值
 * @param {{max?:number}} opts max = 截断长度（默认 300，与调用点原值一致）
 * @returns {{text:string, source:string, degraded:boolean}}
 *   `source` 标明**实际取自哪一条路径**（便于回溯判据是否合适）
 *   `degraded=true` 表示「输入有信息但提取失败，已回落到结构化文本」
 */
export function errText(v, { max = 300 } = {}) {
  const cut = (s) => {
    const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return t.length > max ? t.slice(0, max) + '…(已截断)' : t;
  };

  // ① 字符串
  if (typeof v === 'string') return { text: cut(v), source: 'string', degraded: false };

  // ② Error 实例
  if (v instanceof Error) {
    const name = v.name || 'Error';
    const msg = v.message || '';
    const extra = v.code ? ` (code=${v.code})` : '';
    return { text: cut(msg ? `${name}: ${msg}${extra}` : `${name}${extra}`), source: 'Error', degraded: false };
  }

  // ③/④ 对象：先探测常见字段，再回落到完整结构
  if (isPlainish(v)) {
    for (const k of MESSAGE_KEYS) {
      const val = v[k];
      if (typeof val === 'string' && val.trim()) return { text: cut(val), source: `obj.${k}`, degraded: false };
      // 字段本身是对象 → 再探一层
      if (isPlainish(val) && !Array.isArray(val)) {
        for (const k2 of MESSAGE_KEYS) {
          const v2 = val[k2];
          if (typeof v2 === 'string' && v2.trim()) return { text: cut(`${k}.${k2}: ${v2}`), source: `obj.${k}.${k2}`, degraded: false };
        }
      }
    }
    for (const k of NESTED_KEYS) {
      if (!isPlainish(v[k])) continue;
      for (const k2 of MESSAGE_KEYS) {
        const v2 = v[k][k2];
        if (typeof v2 === 'string' && v2.trim()) return { text: cut(`${k}.${k2}: ${v2}`), source: `obj.${k}.${k2}`, degraded: false };
      }
    }
    // 数组：取第一个可提取的元素（常见于 `errors: [{...}]`）
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        const sub = errText(v[i], { max });
        if (sub.text && sub.text !== '[object Object]') return { text: cut(`[${i}] ${sub.text}`), source: `arr[${i}].${sub.source}`, degraded: false };
      }
    }
    // ④ 回落：**无条件标注**。
    //   ⚠ 我第一版写的是 `body === '[object Object]' ? 标注 : body`——**那个条件恒不成立**：
    //   走到这里说明 `JSON.stringify` 成功，而它对裸对象**必然**产出 `{"k":v}` 形式，
    //   不可能是 `[object Object]`。于是标注从未被加上，回落路径交出去的还是一句「看不出问题」的裸 JSON。
    //   **走到这个分支本身就是「没提取到字段」的定义**，所以标注无条件加。
    let json;
    try { json = JSON.stringify(v); } catch (e) { json = '(无法 JSON 序列化：' + (e.message || e) + ')'; }
    const body = cut(json || '(空对象)');
    return {
      text: '[无可提取字段，已回落到完整结构] ' + body,
      source: 'json-fallback',
      degraded: true,
    };
  }

  // ⑤ 其他
  if (v === null) return { text: '(null)', source: 'null', degraded: false };
  if (v === undefined) return { text: '(undefined)', source: 'undefined', degraded: false };
  return { text: cut(String(v)), source: typeof v, degraded: false };
}

/**
 * catch 块专用：替代 `String(e.message || e)`。
 *
 * 那个写法的两个毛病：
 *   ① `e` 没有 `.message` 时退化成 `String(e)` —— 对裸对象同样是 `[object Object]`；
 *   ② `e.message` **可能为空字符串**，`'' || e` 会取到 `e` 本身，于是空消息被替换成对象串。
 */
export function caughtText(e, { max = 300 } = {}) {
  if (e && typeof e === 'object' && typeof e.message === 'string' && e.message.trim()) {
    const r = errText(e, { max });
    // Error 走 errText 会带上 name（如 `TypeError: xxx`），更好
    return r;
  }
  return errText(e, { max });
}

/** 只要文本的便捷版 */
export function errLine(v, opts) {
  return errText(v, opts).text;
}
