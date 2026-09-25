/**
 * 自主派单·事件驱动监听（样例，无人值守）
 *
 * 轮询 GitLab 新建/更新的 MR，自动创建 router 会话并发起「自主派单评审」。
 * 用法：
 *   node scripts/autodispatch-watcher.mjs --once          # 轮询一次（连通性测试）
 *   node scripts/autodispatch-watcher.mjs --interval 60   # 每 60 秒循环（常驻，Ctrl+C 停止）
 *
 * 环境变量（均可选项，见默认值）：
 *   GITLAB_API_URL    默认 https://gitlab.com/api/v4
 *   GITLAB_PERSONAL_ACCESS_TOKEN        必填（只读 API token 即可）
 *   AUTODISPATCH_DIR   项目目录（默认本仓库根目录）
 *   AUTODISPATCH_STATE 状态文件路径（默认 %APPDATA%\ai.opencode.desktop\autodispatch-state.json）
 *
 * 依赖：本机已运行 OpenCode（桌面版后台服务），且已启用 default_agent=router；
 *       子 Agent 运行需要有效的模型配置（登录/API key），免费直连模式可能被额度限制。
 *
 * 工作原理：GitLab 出现新建/更新 MR → 调用本机 OpenCode 服务 API 创建 router 会话 →
 *          发起「自主评审」提示词 → router 按《自主介入协议》派单并写派单日志。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ── 探测 opencode-cli：优先桌面版内置（V2 桌面），其次 PATH ──
async function findCli() {
  const appdata = process.env.APPDATA;
  if (appdata) {
    const base = join(appdata, 'ai.opencode.desktop', 'cli');
    try {
      const versions = (await readdir(base)).filter((x) => /^\d/.test(x)).sort().reverse();
      for (const v of versions) {
        const p = join(base, v, 'opencode-cli.exe');
        try { await readFile(p); return p; } catch { /* 尝试下一版本 */ }
      }
    } catch { /* 无桌面版 CLI */ }
  }
  return 'opencode-cli';
}

const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const log = (...a) => console.log(`[${now()}]`, ...a);

async function loadState() {
  const p = process.env.AUTODISPATCH_STATE
    || join(process.env.APPDATA || homedir(), 'ai.opencode.desktop', 'autodispatch-state.json');
  try { return JSON.parse(await readFile(p, 'utf8')); } catch { return {}; }
}
async function saveState(state) {
  const p = process.env.AUTODISPATCH_STATE
    || join(process.env.APPDATA || homedir(), 'ai.opencode.desktop', 'autodispatch-state.json');
  await writeFile(p, JSON.stringify(state, null, 2), 'utf8');
}

// 调用本地 OpenCode 服务 API（复用 opencode-cli 的发现/鉴权，Node 直接 utf8 解码，无转码问题）
async function api(cli, args) {
  const out = await execFile(cli, ['api', 'post', ...args], { maxBuffer: 8 * 1024 * 1024 });
  const text = (out.stdout || '').trim();
  try { return JSON.parse(text); } catch { return text; }
}

async function poll(apiUrl, token, dir, cli) {
  let mrs = [];
  try {
    const res = await fetch(
      `${apiUrl}/merge_requests?state=opened&scope=all&per_page=100&order_by=updated_at&sort=desc`,
      { headers: { 'PRIVATE-TOKEN': token } }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    mrs = await res.json();
  } catch (e) {
    log(`[!] GitLab 拉取失败: ${e.message}（稍后重试）`);
    return;
  }
  const state = await loadState();
  let fired = 0;
  for (const mr of mrs) {
    const key = `${mr.project_id}/${mr.iid}`;
    const seen = state[key];
    const cur = mr.updated_at;
    if (!seen || seen !== cur) {
      fired++;
      log(`→ 事件 MR !${mr.iid}「${mr.title}」${seen ? '更新' : '新建'}`);
      try {
        const ses = await api(cli, ['/api/session', '--data', JSON.stringify({
          title: `autodispatch MR !${mr.iid}`,
          agent: 'router',
          location: { directory: dir },
        })]);
        const sid = (ses && (ses.id || (ses.session && ses.session.id) || (ses.data && ses.data.id))) || '';
        if (!sid) throw new Error(`未取到会话ID: ${JSON.stringify(ses).slice(0, 200)}`);
        log(`  session=${sid}`);
        const text =
          `【事件推送·自主评审】GitLab MR !${mr.iid}「${mr.title}」${seen ? '已更新' : '新建'}（web_url: ${mr.web_url}）。` +
          '请按《自主介入协议》识别事项、派单评审：只出建议、不占A、不自动放行；' +
          '完成后按 #派单留痕 追加审计记录，并输出待人类A签批清单。';
        await api(cli, [`/api/session/${sid}/prompt`, '--data', JSON.stringify({ text })]);
        state[key] = cur;
      } catch (e) {
        log(`[!] 派单失败 ${key}: ${e.message}（记录保留，下次轮询重试）`);
      }
    }
  }
  await saveState(state);
  log(`poll done：MR ${mrs.length} 个，派单 ${fired} 次`);
}

async function main() {
  const flags = process.argv.slice(2);
  const once = flags.includes('--once');
  const iv = Number((flags.find((f) => f.startsWith('--interval=')) || '').split('=')[1] || 60);

  const token = process.env.GITLAB_PERSONAL_ACCESS_TOKEN;
  if (!token) {
    console.error('[错误] 缺少 GITLAB_PERSONAL_ACCESS_TOKEN（只读 API token 即可）。');
    console.error('  设置方式示例（PowerShell）：$env:GITLAB_PERSONAL_ACCESS_TOKEN="<token>"');
    process.exit(2);
  }
  const apiUrl = (process.env.GITLAB_API_URL || 'https://gitlab.com/api/v4').replace(/\/+$/, '');
  const dir = process.env.AUTODISPATCH_DIR || ROOT;
  const cli = await findCli();
  log(`cli=${cli}`);
  log(`gitlab=${apiUrl}`);
  log(`dir=${dir}   mode=${once ? '单次' : `常驻(${iv}s)`}`);

  await poll(apiUrl, token, dir, cli);
  if (!once) setInterval(() => poll(apiUrl, token, dir, cli), iv * 1000);
  else process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });