#!/usr/bin/env node
// game — 统一 Agent 游戏开发命令(项目契约 / 检查 / 构建 / 打包 / 发布)
// 用法:
//   game new <slug> --template <html-canvas|phaser>
//   game check <slug> [--json]
//   game build <slug> [--version <v>]
//   game package <slug> [--targets web]
//   game publish <slug> [--stage] [--activate <版本>] [--publish]
//   game dev <slug> [--port <端口>]
//   game list
// 输出:JSON + 退出码(0=成功,1=失败)。
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';
import http from 'node:http';
import { validateGameManifest } from './lib/validate.mjs';
import { buildProject } from './lib/build.mjs';
import { checkItch, checkPlatformStatus } from './lib/platforms.mjs';
import { browserTest } from './lib/browsertest.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..', '..');
const PROJECTS = path.join(REPO_ROOT, 'projects');
const ARTIFACTS = path.join(REPO_ROOT, 'artifacts');
const TEMPLATES = path.join(__dirname, 'templates');

function fail(msg, code = 1) {
  process.stderr.write(msg + '\n');
  process.exit(code);
}
function ok(obj) {
  process.stdout.write((typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2)) + '\n');
}
function projDir(slug) { return path.join(PROJECTS, slug); }
function requireSlug(slug) {
  const d = projDir(slug);
  if (!fs.existsSync(path.join(d, 'game.json'))) fail(`❌ 项目不存在: ${slug} (缺少 projects/${slug}/game.json)`);
  return d;
}
function readManifest(slug) {
  const d = requireSlug(slug);
  return { d, m: JSON.parse(fs.readFileSync(path.join(d, 'game.json'), 'utf8')) };
}

// ---------- new ----------
function cmdNew(slug, template) {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) fail(`❌ slug 只允许小写字母/数字/连字符: ${slug}`);
  if (template !== 'html-canvas' && template !== 'phaser') fail(`❌ 未知模板: ${template}(支持 html-canvas / phaser)`);
  const dest = projDir(slug);
  if (fs.existsSync(dest)) fail(`❌ 已存在: projects/${slug}`);
  const tplDir = path.join(TEMPLATES, template);
  fs.mkdirSync(path.join(dest, 'assets'), { recursive: true });
  fs.cpSync(tplDir, dest, { recursive: true });
  // 写入 game.json(id/title 用 slug)
  const g = JSON.parse(fs.readFileSync(path.join(dest, 'game.json'), 'utf8'));
  g.id = slug;
  g.title = slug;
  fs.writeFileSync(path.join(dest, 'game.json'), JSON.stringify(g, null, 2) + '\n');
  ok({ ok: true, slug, template, path: `projects/${slug}` });
}

// ---------- check ----------
function cmdCheck(slug, asJson, platform) {
  const { d, m } = readManifest(slug);
  const v = validateGameManifest(m);
  const entryRel = m.entry || 'index.html';
  const entryMissing = !fs.existsSync(path.join(d, entryRel));
  if (entryMissing) v.errors.push(`入口文件缺失: ${entryRel}`);
  // store 素材存在性(封面/截图/说明/变更日志,缺项记为待办而非错误)
  const store = m.store || {};
  const storeRefs = [store.cover, ...(store.screenshots || []), store.video, store.instructions, store.changelog].filter(Boolean);
  for (const ref of storeRefs) {
    if (!fs.existsSync(path.join(d, ref))) v.warnings.push(`store 素材缺失(待办): ${ref}`);
  }
  // 平台状态跟踪
  v.warnings.push(...checkPlatformStatus(m));
  // 平台专项校验(需构建产物)
  let platResult = null;
  if (platform) {
    try {
      const r = buildProject({ projectDir: d, outRoot: ARTIFACTS, version: m.version });
      if (platform === 'itch') platResult = checkItch({ manifest: m, webDir: r.webDir });
      else v.warnings.push(`未知平台校验: ${platform}(已忽略)`);
    } catch (e) {
      platResult = { platform, ok: false, errors: [e.message], warnings: [] };
    }
    if (platResult) {
      platResult.errors.forEach((e) => v.errors.push(e));
      platResult.warnings.forEach((w) => v.warnings.push(w));
    }
  }
  if (asJson) return ok({ slug, platform: platform || null, ok: v.ok && !entryMissing, errors: v.errors, warnings: v.warnings });
  v.errors.forEach((e) => console.log('  ✗ ' + e));
  v.warnings.forEach((w) => console.log('  ⚠ ' + w));
  if (v.errors.length) fail(`❌ check 失败(${v.errors.length} 个错误)`);
  console.log(`✅ ${slug} 检查通过(entry=${entryRel}${platform ? `, platform=${platform}` : ''}, ${v.warnings.length} 个待办提醒)`);
  return 0;
}

// ---------- build ----------
function cmdBuild(slug, version) {
  const { d, m } = readManifest(slug);
  const r = buildProject({ projectDir: d, outRoot: ARTIFACTS, version });
  if (r.refErrors.length) fail(`❌ build 失败:\n  - ${r.refErrors.join('\n  - ')}`);
  ok({ ok: true, slug, version: r.version, webDir: r.webDir.replace(REPO_ROOT + path.sep, ''), files: r.copied.length });
}

// ---------- package ----------
function doPackage(slug, targetsArr, version) {
  const { d, m } = readManifest(slug);
  const r = buildProject({ projectDir: d, outRoot: ARTIFACTS, version });
  if (r.refErrors.length) throw new Error(`build 失败:\n  - ${r.refErrors.join('\n  - ')}`);
  const artDir = path.join(ARTIFACTS, slug, r.version);
  const made = [];
  for (const t of targetsArr) {
    if (t === 'web' || t === 'itch') {
      const zipPath = path.join(artDir, t === 'itch' ? 'itch.zip' : 'web.zip');
      // 在 web 目录内打包,保证 ZIP 根目录直接包含 index.html(符合网页平台要求)
      const res = spawnSync('zip', ['-r', '-q', zipPath, '.'], { cwd: r.webDir });
      if (res.status !== 0) throw new Error(`打包失败: ${res.stderr?.toString() || 'zip 错误'}`);
      if (t === 'itch') {
        const p = checkItch({ manifest: m, webDir: r.webDir });
        if (!p.ok) throw new Error(`itch 校验失败:\n  - ${p.errors.join('\n  - ')}`);
        console.log(`    ✓ ${slug} itch 校验通过`);
      }
      made.push(t === 'itch' ? 'itch.zip' : 'web.zip');
    } else if (t === 'source') {
      const zipPath = path.join(artDir, 'source.zip');
      const res = spawnSync('zip', ['-r', '-q', zipPath, '.'], { cwd: d });
      if (res.status !== 0) throw new Error(`源码打包失败: ${res.stderr?.toString() || 'zip 错误'}`);
      made.push('source.zip');
    } else {
      console.warn(`    ⚠ 目标 ${t} 尚未实现适配器,已跳过`);
    }
  }
  return { artDir, made };
}

function cmdPackage(slug, targets, version) {
  const targetsArr = (targets || 'web').split(',').map((s) => s.trim()).filter(Boolean);
  try {
    const { artDir, made } = doPackage(slug, targetsArr, version);
    ok({ ok: true, slug, version, dir: artDir.replace(REPO_ROOT + path.sep, ''), made });
  } catch (e) {
    fail('❌ ' + e.message);
  }
}

// ---------- export-all ----------
function cmdExportAll(targets, version) {
  const targetsArr = (targets || 'web,itch,source').split(',').map((s) => s.trim()).filter(Boolean);
  const items = fs.readdirSync(PROJECTS, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(PROJECTS, e.name, 'game.json')))
    .map((e) => e.name);
  if (!items.length) fail('❌ 没有可导出的项目');
  let failed = 0;
  for (const slug of items) {
    try {
      const { artDir, made } = doPackage(slug, targetsArr, version);
      console.log(`  ✓ ${slug}: ${made.join(', ')}`);
    } catch (e) {
      failed++;
      console.error(`  ✗ ${slug}: ${e.message}`);
    }
  }
  if (failed) fail(`❌ export-all 完成,${failed}/${items.length} 个失败`);
  ok({ ok: true, exported: items.length, targets: targetsArr });
}

// ---------- publish ----------
function cmdPublish(slug, opts) {
  const { d, m } = readManifest(slug);
  // 先构建,从构建产物发布(保证只发运行时内容)
  const r = buildProject({ projectDir: d, outRoot: ARTIFACTS, version: opts.version });
  if (r.refErrors.length) fail(`❌ build 失败:\n  - ${r.refErrors.join('\n  - ')}`);
  const publishScript = path.join(REPO_ROOT, 'scripts', 'publish.mjs');
  const args = [publishScript, r.webDir, '--slug', slug, '--title', m.title, '--genre', m.genre || '未分类', '--source', 'game-cli'];
  if (opts.stage) args.push('--stage');
  if (opts.activate) { args.push('--activate'); args.push(opts.activate); }
  else if (opts.stage) { /* 只暂存,不激活 */ }
  else { args.push('--activate'); args.push(opts.version || m.version || '0.0.0'); } // 默认激活为 game.json 版本,与交付物目录对齐
  if (opts.publish) args.push('--publish');
  const res = spawnSync(process.execPath, args, { stdio: 'inherit' });
  process.exit(res.status ?? 1);
}

// ---------- rollback / promote ----------
async function apiCall(slug, urlPath, method, body) {
  const base = String(process.env.GAME_STATION_URL || 'http://127.0.0.1:3210').replace(/\/+$/, '');
  const token = process.env.GAME_STATION_TOKEN || '';
  const res = await fetch(base + urlPath, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { 'x-admin-token': token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) {}
  if (!res.ok) throw new Error(`${method} ${urlPath} → ${res.status} ${data?.error || data?.message || text.slice(0, 200)}`);
  return data;
}
async function cmdRollback(slug, releaseId) {
  if (!slug || !releaseId) fail('用法: game rollback <slug> --release <id>');
  const d = await apiCall(slug, `/api/games/${slug}/rollback`, 'POST', { releaseId: Number(releaseId) });
  ok({ ok: true, slug, restored: d.restored, releaseId });
}
async function cmdPromote(slug, releaseId) {
  if (!slug || !releaseId) fail('用法: game promote <slug> --release <id>');
  const d = await apiCall(slug, `/api/games/${slug}/rollback`, 'POST', { releaseId: Number(releaseId) });
  await apiCall(slug, `/api/games/${slug}`, 'PATCH', { playable: true });
  ok({ ok: true, slug, promoted: d.restored, releaseId, playable: true });
}

// ---------- dev ----------
function cmdDev(slug, port) {
  const { d, m } = readManifest(slug);
  const root = d;
  const p = Number(port || 4000);
  const entry = m.entry || 'index.html';
  const types = {
    '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png',
    '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
    '.webm': 'video/webm',
  };
  http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
    let p2 = decodeURIComponent(u.pathname);
    if (p2 === '/') p2 = '/' + entry;
    const f = path.resolve(root, '.' + p2);
    if (!f.startsWith(root + path.sep) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
      res.writeHead(404); return res.end('404');
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  }).listen(p, '127.0.0.1', () => {
    console.log(`🎮 dev: http://127.0.0.1:${p}/${entry}  (projects/${slug})`);
  });
}

// ---------- screenshot ----------
function cmdScreenshot(slug) {
  const { d, m } = readManifest(slug);
  const r = buildProject({ projectDir: d, outRoot: ARTIFACTS, version: m.version });
  if (r.refErrors.length) fail(`❌ build 失败:\n  - ${r.refErrors.join('\n  - ')}`);
  const chrome = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (!fs.existsSync(chrome)) fail(`❌ 未找到 Chrome: ${chrome}(可设置 CHROME_BIN)`);
  const store = path.join(d, 'store');
  fs.mkdirSync(store, { recursive: true });
  const size = m.recommendedSize || { width: 800, height: 600 };
  const port = 4200 + Math.floor(Math.random() * 400);
  const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg' };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
    let p2 = decodeURIComponent(u.pathname);
    if (p2 === '/') p2 = '/' + (m.entry || 'index.html');
    const f = path.resolve(r.webDir, '.' + p2);
    if (!f.startsWith(r.webDir + path.sep) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}/`;
    const shots = ['cover.png', 'screenshot-1.png'];
    let pending = shots.length;
    const finish = () => { if (--pending <= 0) { server.close(); ok({ ok: true, slug, storeDir: `projects/${slug}/store`, size }); } };
    for (const name of shots) {
      const out = path.join(store, name);
      const profile = `/tmp/ch-shot-${slug}-${Date.now()}`;
      const proc = spawn(chrome, [
        '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
        `--user-data-dir=${profile}`, `--window-size=${size.width},${size.height}`,
        '--virtual-time-budget=6000', `--screenshot=${out}`, url,
      ], { stdio: 'ignore' });
      // 看门狗:截图文件出现或超时 20s 即终止 Chrome(rAF 游戏不自动退出)
      const t0 = Date.now();
      const timer = setInterval(() => {
        if (fs.existsSync(out) && fs.statSync(out).size > 0) {
          clearInterval(timer); proc.kill('SIGKILL');
          console.log(`  📸 ${name}: ${(fs.statSync(out).size / 1024).toFixed(1)} KB`);
          finish();
        } else if (Date.now() - t0 > 20000) {
          clearInterval(timer); proc.kill('SIGKILL');
          console.log(`  ⚠ ${name}: 超时未生成`);
          finish();
        }
      }, 400);
    }
  });
}

// ---------- test (browser) ----------
async function cmdTest(slug, browser) {
  const { d, m } = readManifest(slug);
  const r = buildProject({ projectDir: d, outRoot: ARTIFACTS, version: m.version });
  if (r.refErrors.length) fail(`❌ build 失败:\n  - ${r.refErrors.join('\n  - ')}`);
  if (!browser) {
    console.log(`ℹ ${slug} 通过了 check/build;浏览器玩法测试请加 --browser`);
    return 0;
  }
  const size = m.recommendedSize || { width: 800, height: 600 };
  const port = 4300 + Math.floor(Math.random() * 500);
  const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg' };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); } // 消除 favicon 误报,保留真实缺失资源 404
    let p2 = decodeURIComponent(u.pathname);
    if (p2 === '/') p2 = '/' + (m.entry || 'index.html');
    const f = path.resolve(r.webDir, '.' + p2);
    if (!f.startsWith(r.webDir + path.sep) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise((res) => server.listen(port, '127.0.0.1', res));
  const url = `http://127.0.0.1:${port}/`;
  const tapPoints = [
    [Math.round(size.width / 2), Math.round(size.height / 2)],
    [Math.round(size.width / 2) + 60, Math.round(size.height / 2) + 40],
    [Math.round(size.width / 2) - 40, Math.round(size.height / 2) - 30],
  ];
  const artDir = path.join(ARTIFACTS, slug, r.version);
  const report = await browserTest({
    url,
    screenshotPath: path.join(artDir, 'browser-test.png'),
    actions: {
      // 点开始/重开(按常见 id 与文本兜底)
      start: `(() => {
        const ids=['startBtn','start-btn','newRun','restart-btn','restartBtn','playBtn'];
        for (const id of ids){ const el=document.getElementById(id); if(el){ el.click(); return id; } }
        const b=[...document.querySelectorAll('button')].find(b=>/开始|新的远征|重新开始|重开|start/i.test(b.textContent||''));
        if(b){ b.click(); return 'text:'+(b.textContent||'').trim().slice(0,12); }
        return null;
      })()`,
      waitAfterStart: 1800,
      tapPoints,
      finalState: `(() => ({
        title: document.title,
        hasCanvas: !!document.querySelector('canvas'),
        bodyLen: document.body.innerText.length,
        startOverlayVisible: (() => { const o=document.getElementById('start-overlay')||document.getElementById('overlay'); return o ? !o.classList.contains('hidden') && o.style.display !== 'none' : false; })()
      }))()`,
    },
  });
  fs.writeFileSync(path.join(artDir, 'browser-test-report.json'), JSON.stringify(report, null, 2));
  server.close();
  report.startedBy = report.startedBy || null;
  ok({ ok: report.ok, slug, version: r.version, consoleErrors: report.consoleErrors.length, startedBy: report.startedBy, screenshot: 'browser-test.png', reportFile: 'browser-test-report.json' });
  return report.ok ? 0 : 1;
}

// ---------- list ----------
function cmdList() {
  if (!fs.existsSync(PROJECTS)) return ok([]);
  const items = fs.readdirSync(PROJECTS, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(PROJECTS, e.name, 'game.json')))
    .map((e) => {
      const m = JSON.parse(fs.readFileSync(path.join(PROJECTS, e.name, 'game.json'), 'utf8'));
      return { id: m.id, title: m.title, version: m.version, engine: m.engine, platforms: Object.keys(m.platforms || {}).length };
    });
  ok(items);
}

// ---------- main ----------
const args = process.argv.slice(2);
const cmd = args[0];
const rest = args.slice(1);
const pick = (key, fallback) => {
  const i = rest.indexOf(`--${key}`);
  return i >= 0 && rest[i + 1] ? rest[i + 1] : fallback;
};
const flag = (key) => rest.includes(`--${key}`);
const slug = rest[0];

async function main() {
  switch (cmd) {
    case 'new': return cmdNew(slug, pick('template', 'html-canvas'));
    case 'check': return cmdCheck(slug, flag('json'), pick('platform', null));
    case 'build': return cmdBuild(slug, pick('version', null));
    case 'package': return cmdPackage(slug, pick('targets', 'web'), pick('version', null));
    case 'publish': return cmdPublish(slug, { stage: flag('stage'), activate: pick('activate', null), publish: flag('publish'), version: pick('version', null) });
    case 'dev': return cmdDev(slug, pick('port', null));
    case 'screenshot': return cmdScreenshot(slug);
    case 'test': return await cmdTest(slug, flag('browser'));
    case 'export-all': return cmdExportAll(pick('targets', 'web,itch,source'), pick('version', null));
    case 'rollback': return await cmdRollback(slug, pick('release', null));
    case 'promote': return await cmdPromote(slug, pick('release', null));
    case 'list': return cmdList();
    default:
      fail('用法:\n  game new <slug> --template <html-canvas|phaser>\n  game check <slug> [--json|--platform itch]\n  game build <slug> [--version v]\n  game package <slug> [--targets web,itch,source]\n  game publish <slug> [--stage|--activate v] [--publish]\n  game test <slug> --browser\n  game dev <slug> [--port]\n  game screenshot <slug>\n  game export-all [--targets web,itch,source]\n  game rollback <slug> --release <id>\n  game promote <slug> --release <id>\n  game list');
  }
}
main().then((code) => { if (typeof code === 'number') process.exit(code); }).catch((e) => { console.error('❌ ' + e.message); process.exit(1); });
