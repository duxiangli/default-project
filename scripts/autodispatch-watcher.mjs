/**
 * 自主派单·本地 git 监听（样例）
 *
 * 监听本机仓库的新提交：发现基线之外的新提交，自动创建 router 会话并派发「自主评审」。
 * 纯本地、零凭据（不需要 GitLab/token）——适合单人单机在 OpenCode 桌面版干活。
 *
 * 用法：
 *   node scripts/autodispatch-watcher.mjs --once --dry-run      # 连通性测试：只报告，不派单（首次运行自动建立基线）
 *   node scripts/autodispatch-watcher.mjs --once                # 跑一轮：检测新提交并派单
 *   node scripts/autodispatch-watcher.mjs --interval 60         # 常驻轮询（Ctrl+C 停止）
 *   node scripts/autodispatch-watcher.mjs "--mock-mr=冒烟标题" --once   # 零真实提交的全链路冒烟（不依赖新提交）
 *   node scripts/autodispatch-watcher.mjs --project-dir=C:/path/to/repo --once
 *
 * 说明：
 * - 首次运行只建立基线（把当前提交窗口记入状态），不会把历史提交全部派单；
 * - 之后每次轮询，检测到基线之外的新提交 → 创建 router 会话并派发「自主评审」提示词；
 * - 状态文件默认 %APPDATA%\ai.opencode.desktop\autodispatch-state.json（可用 AUTODISPATCH_STATE 覆盖）；
 * - 仓库目录可用 --project-dir 或 AUTODISPATCH_DIR 覆盖（默认本仓库）。
 *
 * 工作原理：新提交 → 调用本机 OpenCode 服务 API 创建 router 会话 →
 *          发起「自主评审」提示词 → router 按《自主介入协议》派单、写派单日志并生成待签批项。
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
      const versions = (await readdir(base))
        .filter((x) => /^\d/.test(x))
        .map((x) => ({ x, n: x.split('.').map((p) => Number((p.split('-')[0] || '0'))) }))
        .sort((a, b) => {
          const len = Math.max(a.n.length, b.n.length);
          for (let i = 0; i < len; i++) { const d = (b.n[i] || 0) - (a.n[i] || 0); if (d) return d; }
          return 0;
        })
        .map((o) => o.x);
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
  const out = await exec(cli, ['api', 'post', ...args], { maxBuffer: 8 * 1024 * 1024 });
  const text = (out.stdout || '').trim();
  try { return JSON.parse(text); } catch { return text; }
}

function parseFlags(argv) {
  const f = { once: false, dryRun: false, interval: 60, mockMr: null, projectDir: null };
  for (const a of argv) {
    if (a === '--once') f.once = true;
    else if (a === '--dry-run') f.dryRun = true;
    else if (a.startsWith('--interval=')) f.interval = Math.max(0, Number(a.slice(11)));
    else if (a.startsWith('--mock-mr=')) f.mockMr = a.slice(10);
    else if (a.startsWith('--project-dir=')) f.projectDir = a.slice(14);
  }
  return f;
}

async function git(dir, args) {
  const out = await exec('git', ['-C', dir, ...args], { maxBuffer: 4 * 1024 * 1024 });
  return (out.stdout || '').replace(/\r?\n$/, '');
}

async function isGitRepo(dir) {
  try { return (await git(dir, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true'; } catch { return false; }
}

// 读取仓库提交窗口：最近 200 条「hash|subject」
async function getCommits(dir) {
  const raw = await git(dir, ['log', '--pretty=%H|%s', '-n', '200']);
  if (!raw.trim()) return [];
  return raw.split(/\r?\n/).filter(Boolean).map((line) => {
    const i = line.indexOf('|');
    return i === -1 ? { hash: line, subject: '' } : { hash: line.slice(0, i), subject: line.slice(i + 1) };
  });
}

const REVIEW_PROMPT = (body) =>
  `${body}\n请按《自主介入协议》识别事项、派单评审：只出建议、不占A、不自动放行；` +
  '完成后按 #派单留痕 追加审计记录，需签批项进入 #待签批清单，并输出待人类A签批清单。';

async function dispatch(cli, dir, titleHead, text) {
  const ses = await api(cli, ['/api/session', '--data', JSON.stringify({
    title: `autodispatch ${titleHead}`,
    agent: 'router',
    location: { directory: dir },
  })]);
  const sid = (ses && (ses.id || (ses.session && ses.session.id) || (ses.data && ses.data.id))) || '';
  if (!sid) throw new Error(`未取到会话ID: ${JSON.stringify(ses).slice(0, 200)}`);
  log(`  session=${sid}`);
  await api(cli, [`/api/session/${sid}/prompt`, '--data', JSON.stringify({ text })]);
  return sid;
}

async function poll(ctx) {
  const { cli, flags, repoKey, dir } = ctx;

  if (!(await isGitRepo(dir))) {
    log(`[!] ${dir} 不是 git 仓库，跳过`);
    return;
  }
  let commits = [];
  try { commits = await getCommits(dir); } catch (e) { log(`[!] git log 失败: ${e.message}`); return; }

  const state = await loadState();
  const cur = new Date().toISOString();
  const prev = state[repoKey];

  // ── 冒烟模式：合成事件，直接走派单管线 ──
  if (flags.mockMr) {
    if (flags.dryRun) { log(`dry-run：将派单 [mock] ${flags.mockMr}`); return; }
    log(`→ 事件 [mock] ${flags.mockMr}`);
    try {
      await dispatch(cli, dir, 'smoke', REVIEW_PROMPT(`【事件推送·自主评审】本地冒烟事件：「${flags.mockMr}」。`));
      state[repoKey] = { seenHashes: prev ? prev.seenHashes : [], lastCheck: cur };
      await saveState(state);
      log('poll done：派单 1 次');
    } catch (e) {
      log(`[!] 派单失败: ${e.message}`);
    }
    return;
  }

  // ── 首次运行：建立基线，不派单 ──
  if (!prev) {
    state[repoKey] = { seenHashes: commits.map((c) => c.hash), lastHead: '', lastCheck: cur };
    await saveState(state);
    log(`首次运行：已建立基线（${commits.length} 条历史提交记入状态），本次不派单`);
    return;
  }

  const seenSet = new Set(prev.seenHashes || []);
  const fresh = commits.filter((c) => !seenSet.has(c.hash));

  if (flags.dryRun) {
    log(`dry-run：当前窗口 ${commits.length} 条，新提交 ${fresh.length} 条`);
    for (const c of fresh) log(`  [will-fire] ${c.hash.slice(0, 8)} ${c.subject}`);
    return;
  }

  if (fresh.length === 0) { log('poll done：无新提交'); return; }

  const listText = fresh.slice(0, 10).map((c) => `${c.hash.slice(0, 8)} ${c.subject}`).join('\n');
  const head = fresh[0].hash.slice(0, 8);
  log(`→ 事件 新提交 ${fresh.length} 条（${fresh.map((c) => c.hash.slice(0, 8)).join(',')}）`);
  try {
    await dispatch(cli, dir, head, REVIEW_PROMPT(`【事件推送·自主评审】本地仓库检测到新提交 ${fresh.length} 条：\n${listText}`));
    state[repoKey] = { seenHashes: commits.map((c) => c.hash), lastHead: head, lastCheck: cur };
    await saveState(state);
    log(`poll done：新提交 ${fresh.length} 条，派单 1 次`);
  } catch (e) {
    log(`[!] 派单失败: ${e.message}（记录保留，下次轮询重试）`);
  }
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const dir = flags.projectDir || process.env.AUTODISPATCH_DIR || ROOT;
  const cli = await findCli();
  const repoKey = resolve(dir);
  log(`cli=${cli}`);
  log(`repo=${repoKey}`);
  log(`mode=${flags.once ? '单次' : `常驻(${flags.interval}s)`}   dryRun=${flags.dryRun}   mockMr=${flags.mockMr || '-'}`);

  await poll({ cli, flags, repoKey, dir });
  if (!flags.once) setInterval(() => poll({ cli, flags, repoKey, dir }), flags.interval * 1000);
  else process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });