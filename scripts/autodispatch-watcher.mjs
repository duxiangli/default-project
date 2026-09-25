/**
 * 自主派单·事件驱动监听（样例，无人值守）
 *
 * 轮询 GitLab 新建/更新的 MR，自动创建 router 会话并发起「自主派单评审」。
 *
 * 用法：
 *   node scripts/autodispatch-watcher.mjs --once --dry-run      # 连通性测试：只报告会触发的事件，不派单
 *   node scripts/autodispatch-watcher.mjs --force-mr=<项目ID>/<MR IID> --once   # 指定单个 MR 强制派单（真·冒烟）
 *   node scripts/autodispatch-watcher.mjs --interval 60         # 每 60 秒循环（常驻，Ctrl+C 停止）
 *   node scripts/autodispatch-watcher.mjs --project=<项目ID> --once --dry-run   # 只看指定项目
 *
 * 配置（优先级：OS 环境变量 > 仓库根目录 .env，.env 已 gitignore）：
 *   GITLAB_API_URL                默认 https://gitlab.com/api/v4
 *   GITLAB_PERSONAL_ACCESS_TOKEN  必填（只读 API token 即可）
 *   GITLAB_PROJECT_ID             可选：只监听指定项目
 *   AUTODISPATCH_DIR   项目目录（默认本仓库根目录）
 *   AUTODISPATCH_STATE 状态文件路径（默认 %APPDATA%\ai.opencode.desktop\autodispatch-state.json）
 *
 * 依赖：本机已运行 OpenCode（桌面版后台服务），已启用 default_agent=router；
 *       子 Agent 运行需要有效模型配置（登录/API key）。
 *
 * 工作原理：GitLab 出现新建/更新 MR → 调用本机 OpenCode 服务 API 创建 router 会话 →
 *          发起「自主评审」提示词 → router 按《自主介入协议》派单、写派单日志并生成待签批项。
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ── 加载 .env（简单 KV，不引第三方依赖；OS 环境变量优先） ──
try {
  const raw = readFileSync(join(ROOT, '.env'), 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const eq = s.indexOf('=');
    if (eq <= 0) continue;
    const k = s.slice(0, eq).trim();
    const v = s.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!(k in process.env)) process.env[k] = v;
  }
} catch { /* 无 .env 文件则忽略 */ }

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

function parseFlags(argv) {
  const f = { once: false, dryRun: false, interval: 60, forceMr: null, project: null };
  for (const a of argv) {
    if (a === '--once') f.once = true;
    else if (a === '--dry-run') f.dryRun = true;
    else if (a.startsWith('--interval=')) f.interval = Math.max(0, Number(a.slice(11)));
    else if (a.startsWith('--force-mr=')) f.forceMr = a.slice(11);
    else if (a.startsWith('--project=')) f.project = a.slice(10);
  }
  return f;
}

async function getMRs(apiUrl, token, project) {
  const q = project
    ? `/projects/${project}/merge_requests?state=opened&per_page=100&order_by=updated_at&sort=desc`
    : `/merge_requests?state=opened&scope=all&per_page=100&order_by=updated_at&sort=desc`;
  const res = await fetch(apiUrl + q, { headers: { 'PRIVATE-TOKEN': token } });
  if (!res.ok) throw new Error(`HTTP ${res.status} (${res.statusText})`);
  return res.json();
}

async function getOneMR(apiUrl, token, pid, iid) {
  const res = await fetch(`${apiUrl}/projects/${pid}/merge_requests/${iid}`, { headers: { 'PRIVATE-TOKEN': token } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function dispatch(cli, dir, mr, isNew) {
  const ses = await api(cli, ['/api/session', '--data', JSON.stringify({
    title: `autodispatch MR !${mr.iid}`,
    agent: 'router',
    location: { directory: dir },
  })]);
  const sid = (ses && (ses.id || (ses.session && ses.session.id) || (ses.data && ses.data.id))) || '';
  if (!sid) throw new Error(`未取到会话ID: ${JSON.stringify(ses).slice(0, 200)}`);
  log(`  session=${sid}`);
  const text =
    `【事件推送·自主评审】GitLab MR !${mr.iid}「${mr.title}」${isNew ? '新建' : '已更新'}（web_url: ${mr.web_url}）。` +
    '请按《自主介入协议》识别事项、派单评审：只出建议、不占A、不自动放行；' +
    '完成后按 #派单留痕 追加审计记录，需签批项进入 #待签批清单，并输出待人类A签批清单。';
  await api(cli, [`/api/session/${sid}/prompt`, '--data', JSON.stringify({ text })]);
}

async function poll(ctx) {
  const { apiUrl, token, cli, flags } = ctx;
  let mrs = [];
  try {
    const [pid, iid] = flags.forceMr ? flags.forceMr.split('/') : [null, null];
    mrs = pid ? [await getOneMR(apiUrl, token, pid, iid)] : await getMRs(apiUrl, token, flags.project || process.env.GITLAB_PROJECT_ID || null);
  } catch (e) {
    log(`[!] GitLab 拉取失败: ${e.message}（稍后重试）`);
    return;
  }
  const state = await loadState();
  const events = [];
  for (const mr of mrs) {
    if (!mr || typeof mr.iid === 'undefined') continue;
    const key = `${mr.project_id || (mr.project && mr.project.id)}/${mr.iid}`;
    const seen = state[key];
    const cur = mr.updated_at;
    const isNew = !seen;
    if (flags.forceMr || !seen || seen !== cur) events.push({ mr, key, isNew, cur });
  }
  if (flags.dryRun) {
    log(`dry-run：GitLab MR 命中 ${mrs.length} 个，将触发派单 ${events.length} 个`);
    for (const e of events) log(`  [will-fire] MR !${e.mr.iid}「${e.mr.title}」${e.isNew ? '新建' : '更新'}`);
    return; // 不落状态、不派单
  }
  let fired = 0;
  for (const e of events) {
    log(`→ 事件 MR !${e.mr.iid}「${e.mr.title}」${e.isNew ? '新建' : '更新'}`);
    try {
      await dispatch(cli, ctx.dir, e.mr, e.isNew);
      state[e.key] = e.cur;
      fired++;
    } catch (err) {
      log(`[!] 派单失败 ${e.key}: ${err.message}（记录保留，下次轮询重试）`);
    }
  }
  await saveState(state);
  log(`poll done：MR 命中 ${mrs.length} 个，派单 ${fired} 次`);
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const token = process.env.GITLAB_PERSONAL_ACCESS_TOKEN;
  if (!token) {
    console.error('[错误] 缺少 GITLAB_PERSONAL_ACCESS_TOKEN（只读 API token 即可）。');
    console.error('  设置方式：复制 .env.example 为 .env 填入；或在 PowerShell 执行 $env:GITLAB_PERSONAL_ACCESS_TOKEN="<token>"');
    process.exit(2);
  }
  const apiUrl = (process.env.GITLAB_API_URL || 'https://gitlab.com/api/v4').replace(/\/+$/, '');
  const dir = process.env.AUTODISPATCH_DIR || ROOT;
  const cli = await findCli();
  const ctx = { apiUrl, token, dir, cli, flags };
  log(`cli=${cli}`);
  log(`gitlab=${apiUrl}`);
  log(`dir=${dir}   mode=${flags.once ? '单次' : `常驻(${flags.interval}s)`}   dryRun=${flags.dryRun}   forceMr=${flags.forceMr || '-'}`);

  await poll(ctx);
  if (!flags.once) setInterval(() => poll(ctx), flags.interval * 1000);
  else process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });