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
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import { validateGameManifest } from './lib/validate.mjs';
import { buildProject } from './lib/build.mjs';
import { checkItch, checkPlatformStatus } from './lib/platforms.mjs';

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
function cmdPackage(slug, targets, version) {
  const targetsArr = (targets || 'web').split(',').map((s) => s.trim()).filter(Boolean);
  const { d, m } = readManifest(slug);
  const r = buildProject({ projectDir: d, outRoot: ARTIFACTS, version });
  if (r.refErrors.length) fail(`❌ build 失败:\n  - ${r.refErrors.join('\n  - ')}`);
  const artDir = path.join(ARTIFACTS, slug, r.version);
  const made = [];
  for (const t of targetsArr) {
    if (t === 'web' || t === 'itch') {
      const zipPath = path.join(artDir, t === 'itch' ? 'itch.zip' : 'web.zip');
      // 在 web 目录内打包,保证 ZIP 根目录直接包含 index.html(符合网页平台要求)
      const res = spawnSync('zip', ['-r', '-q', zipPath, '.'], { cwd: r.webDir });
      if (res.status !== 0) fail(`❌ 打包失败: ${res.stderr?.toString() || 'zip 错误'}`);
      if (t === 'itch') {
        // itch 专项校验(入口/相对路径/绝对路径/外部依赖/规模)
        const p = checkItch({ manifest: m, webDir: r.webDir });
        if (!p.ok) fail(`❌ itch 校验失败:\n  - ${p.errors.join('\n  - ')}`);
        console.log(`  ✓ itch 校验通过(${p.warnings.join('; ')})`);
      }
      made.push(t === 'itch' ? 'itch.zip' : 'web.zip');
    } else if (t === 'source') {
      // 源码包:项目目录(不含 .git / artifacts),默认私有
      const zipPath = path.join(artDir, 'source.zip');
      const res = spawnSync('zip', ['-r', '-q', zipPath, '.'], { cwd: d });
      if (res.status !== 0) fail(`❌ 源码打包失败: ${res.stderr?.toString() || 'zip 错误'}`);
      made.push('source.zip');
    } else {
      console.warn(`  ⚠ 目标 ${t} 尚未实现适配器,已跳过`);
    }
  }
  ok({ ok: true, slug, version: r.version, dir: artDir.replace(REPO_ROOT + path.sep, ''), made });
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
    let p2 = decodeURIComponent(new URL(req.url, 'http://x').pathname);
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

function main() {
  switch (cmd) {
    case 'new': return cmdNew(slug, pick('template', 'html-canvas'));
    case 'check': return cmdCheck(slug, flag('json'), pick('platform', null));
    case 'build': return cmdBuild(slug, pick('version', null));
    case 'package': return cmdPackage(slug, pick('targets', 'web'), pick('version', null));
    case 'publish': return cmdPublish(slug, { stage: flag('stage'), activate: pick('activate', null), publish: flag('publish'), version: pick('version', null) });
    case 'dev': return cmdDev(slug, pick('port', null));
    case 'list': return cmdList();
    default:
      fail('用法:\n  game new <slug> --template <html-canvas|phaser>\n  game check <slug> [--json]\n  game build <slug> [--version v]\n  game package <slug> [--targets web]\n  game publish <slug> [--stage|--activate v] [--publish]\n  game dev <slug> [--port]\n  game list');
  }
}
main();
