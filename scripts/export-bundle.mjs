/**
 * 专家团交付包导出脚本（纯 Node，无外部工具依赖）
 *
 * 生成：dist/专家团交付包-<YYYY-MM-DD>.zip
 *   ├─ README.md                     （包内导入说明，源：docs/交付包-README.md）
 *   ├─ 跨平台配置包/docs/expert-team/ （21 张卡 + 主文档 + RACI + 名册 + runbook）
 *   ├─ OpenCode-Agent版/.opencode/    （router + 20 专家 + opencode.jsonc）
 *   └─ scripts/*.mjs                  （validate / sync-roster / autodispatch-watcher / export-bundle）
 *
 * 为什么要这么做（踩坑记录，勿回退）：
 *   1. PowerShell 传中文参数给原生程序（tar.exe 等）按控制台代码页(GBK)转码，zip 内文件名乱码；
 *   2. Compress-Archive 会跳过隐藏/点目录 → .opencode 整体丢失；
 *   3. tar -c . 产生的条目带 "./" 前缀，Windows 原生 Expand-Archive 解出后顶层目录名错乱；
 *   → 本脚本用 fs.cp 原生复制 + 内置 zip 写入器（UTF-8 文件名标志位），
 *     所有中文路径仅存在于 UTF-8 源码内，由 Node fs 原生处理，对任意解压工具友好。
 *
 * 用法：node scripts/export-bundle.mjs [YYYY-MM-DD]（默认今天）
 */
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const date = process.argv[2] || new Date().toISOString().slice(0, 10);
const NAME = `专家团交付包-${date}`;
const STAGE = join(ROOT, 'dist', NAME);
const ZIP = join(ROOT, 'dist', `${NAME}.zip`);

/* ---------- zip 写入器（local header + central directory + EOCD） ---------- */
const crc32 = (buf) => {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
};

/** entries: [{ name: 'a/b/c.md', data: Buffer }]，name 用 '/' 分隔、UTF-8 编码 + 0x0800 标志位 */
function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const f of entries) {
    const name = Buffer.from(f.name, 'utf8');
    const crc = crc32(f.data);
    const comp = deflateRawSync(f.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);   // 版本
    lh.writeUInt16LE(0x0800, 6); // UTF-8 标志
    lh.writeUInt16LE(8, 8);    // deflate
    lh.writeUInt32LE(0, 10);   // 时间/日期
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(f.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);   // extra
    chunks.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(0x031e, 4); // made by: 0x03(unix)<<8 | 0x1e
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(0, 12);
    ch.writeUInt32LE(0, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(f.data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += lh.length + name.length + comp.length;
  }
  const cdStart = offset;
  let cdSize = 0;
  for (const c of central) cdSize += c.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, ...central, eocd]);
}

/* ---------- zip 读取器（自检用：解析 central directory + inflate） ---------- */
function readZip(buf) {
  const eocdPos = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocdPos < 0) throw new Error('EOCD 未找到');
  const cdCount = buf.readUInt16LE(eocdPos + 10);
  const cdStart = buf.readUInt32LE(eocdPos + 16);
  const entries = [];
  let pos = cdStart;
  for (let i = 0; i < cdCount; i++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) throw new Error('central 签名错误');
    const flags = buf.readUInt16LE(pos + 8);
    const method = buf.readUInt16LE(pos + 10);
    const crc = buf.readUInt32LE(pos + 16);
    const compSize = buf.readUInt32LE(pos + 20);
    const size = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const lho = buf.readUInt32LE(pos + 42);
    const name = buf.toString('utf8', pos + 46, pos + 46 + nameLen);
    const lh = buf.readUInt32LE(lho);
    if (lh !== 0x04034b50) throw new Error('local header 签名错误');
    const ln = buf.readUInt16LE(lho + 26);
    const ex = buf.readUInt16LE(lho + 28);
    const dataStart = lho + 30 + ln + ex;
    let data = buf.subarray(dataStart, dataStart + compSize);
    if (method === 8) data = inflateRawSync(data);
    if (data.length !== size) throw new Error(`解压尺寸不符: ${name}`);
    if (crc32(data) !== crc) throw new Error(`CRC 不符: ${name}`);
    entries.push({ name, data, flags });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/* ---------- 1. 重建 staging ---------- */
await rm(STAGE, { recursive: true, force: true });
await rm(ZIP, { force: true });
await mkdir(join(STAGE, '跨平台配置包', 'docs'), { recursive: true });
await mkdir(join(STAGE, 'OpenCode-Agent版'), { recursive: true });
await mkdir(join(STAGE, 'scripts'), { recursive: true });

await cp(join(ROOT, 'docs', 'expert-team'), join(STAGE, '跨平台配置包', 'docs', 'expert-team'), { recursive: true });
await cp(join(ROOT, '.opencode'), join(STAGE, 'OpenCode-Agent版', '.opencode'), { recursive: true });
for (const f of await readdir(join(ROOT, 'scripts'))) {
  if (f.endsWith('.mjs')) await cp(join(ROOT, 'scripts', f), join(STAGE, 'scripts', f));
}
await cp(join(ROOT, 'docs', '交付包-README.md'), join(STAGE, 'README.md'));

const fileNames = [];
const walk = async (d) => {
  for (const e of await readdir(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) await walk(p);
    else fileNames.push(p);
  }
};
await walk(STAGE);

/* ---------- 2. 写入 zip（条目名 = NAME/相对路径，无 "./" 前缀） ---------- */
const entries = [];
for (const p of fileNames) {
  const rel = p.slice(STAGE.length + 1).replaceAll('\\', '/');
  entries.push({ name: `${NAME}/${rel}`, data: await readFile(p) });
}
await writeFile(ZIP, buildZip(entries));

/* ---------- 3. 自检：读回 zip，解压校验 + 关键文件/内容标志 ---------- */
const back = readZip(await readFile(ZIP));
const got = new Set(back.map((e) => e.name));
const missing = [];
for (const k of ['首席名册.csv', '派单日志.md', '待签批清单.md', '审批记录.md', 'RACI矩阵.csv',
  '.opencode/agents/router.md', '.opencode/agents/expert/18-security.md', '.opencode/opencode.jsonc',
  'scripts/validate-expert-team.mjs', 'scripts/autodispatch-watcher.mjs', 'scripts/sync-roster.mjs',
  'scripts/export-bundle.mjs', 'README.md']) {
  if (![...got].some((n) => n.includes(k))) missing.push(k);
}
if (missing.length) { console.error('自检失败，缺少:', missing.join(' | ')); process.exit(1); }
if (back.some((e) => e.name.startsWith('.')) || back.some((e) => e.name.includes('./'))) {
  console.error('自检失败：存在不友好前缀条目'); process.exit(1);
}
const byTail = (k) => back.find((e) => e.name.includes(k));
const markers = [
  ['README.md', '20人资深专家＋专家Agent体系 · 交付包'],
  ['.opencode/agents/router.md', '自主介入协议'],
  ['.opencode/opencode.jsonc', 'default_agent'],
  ['scripts/validate-expert-team.mjs', '结果：'],
  ['scripts/autodispatch-watcher.mjs', '本地 git 监听'],
  ['roster/首席名册.csv', '职位'],
  ['runbook/派单日志.md', 'DSP-'],
];
const bad = [];
for (const [k, m] of markers) {
  const e = byTail(k);
  if (!e) { bad.push(`${k}(未找到)`); continue; }
  if (!e.data.toString('utf8').includes(m)) bad.push(`${k}(缺「${m}」)`);
}
if (bad.length) { console.error('自检失败(内容标志):', bad.join(' | ')); process.exit(1); }

const experts = back.filter((e) => e.name.includes('.opencode/agents/expert/') && e.name.endsWith('.md')).length;
const cards = back.filter((e) => e.name.includes('agent-cards/') && e.name.endsWith('.md')).length;
const kb = Math.round((await stat(ZIP)).size / 1024);
console.log('导出完成 ✓');
console.log(`  路径: ${ZIP}`);
console.log(`  规格: ${back.length} 个文件 / ${kb} KB（专家Agent ${experts}、岗位卡 ${cards}）`);
console.log(`  自检: 14 必需文件 + 7 内容标志 + CRC/size 全部通过，无 ./ 前缀`);