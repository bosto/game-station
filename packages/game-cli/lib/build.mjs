// 构建:把 projects/<id>/ 的运行时文件整理为 artifacts/<id>/<version>/web/
// 并输出 release.json / checksums.sha256 / validation-report.json(校验入口与资源闭包)。
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { validateGameManifest } from './validate.mjs';

// 不入网页包的目录/文件
const EXCLUDE = new Set(['.git', 'node_modules', 'store', 'asset-sources', 'tests', '.DS_Store', '__pycache__', 'game.json']);
function isExcluded(name, rel) {
  if (EXCLUDE.has(name)) return true;
  if (name.startsWith('.bak') || name.endsWith('.bak') || /\.bak-\d+$/.test(name)) return true;
  if (name.endsWith('.md')) return true; // 设计/开发文档不进运行时
  return false;
}

function sha256File(abs) {
  return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
}

// 扫描 entry HTML 里引用的相对本地资源,校验是否存在(闭包检查,启发式)
function collectReferencedFiles(entryAbs, webRoot) {
  const html = fs.readFileSync(entryAbs, 'utf8');
  const refs = new Set();
  const pats = [
    /(?:src|href)\s*=\s*["']([^"'?#]+)["']/g,
    /url\(\s*["']?([^"')]+)["']?\s*\)/g,
    /fetch\(\s*["']([^"']+)["']/g,
  ];
  for (const pat of pats) {
    let m;
    while ((m = pat.exec(html)) !== null) {
      const ref = m[1];
      if (!ref || /^(https?:)?\/\//.test(ref) || ref.startsWith('#') || ref.startsWith('data:')) continue;
      refs.add(ref.split('?')[0]);
    }
  }
  const missing = [];
  for (const ref of refs) {
    const target = path.resolve(path.dirname(entryAbs), ref);
    if (!target.startsWith(webRoot + path.sep)) continue; // 越过根,忽略(由上层校验)
    if (!fs.existsSync(target)) missing.push(ref);
  }
  return missing;
}

export function buildProject({ projectDir, outRoot, version }) {
  const gamePath = path.join(projectDir, 'game.json');
  if (!fs.existsSync(gamePath)) throw new Error(`缺少 ${gamePath}`);
  const manifest = JSON.parse(fs.readFileSync(gamePath, 'utf8'));
  const { ok, errors, warnings } = validateGameManifest(manifest);
  if (!ok) throw new Error(`game.json 校验失败:\n  - ${errors.join('\n  - ')}`);

  const slug = manifest.id;
  const ver = version || manifest.version || '0.0.0';
  const webDir = path.join(outRoot, slug, ver, 'web');
  fs.rmSync(webDir, { recursive: true, force: true });
  fs.mkdirSync(webDir, { recursive: true });

  // 复制运行时文件
  const copied = [];
  (function walk(d, prefix) {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      if (isExcluded(ent.name, prefix)) continue;
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      const src = path.join(d, ent.name);
      if (ent.isDirectory()) walk(src, rel);
      else {
        const dest = path.join(webDir, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
        copied.push(rel);
      }
    }
  })(projectDir, '');

  // 入口与资源闭包检查
  const entryRel = manifest.entry || 'index.html';
  const entryAbs = path.join(webDir, entryRel);
  const entryMissing = !fs.existsSync(entryAbs);
  const missingRefs = entryMissing ? [] : collectReferencedFiles(entryAbs, webDir);
  const refErrors = [
    ...(entryMissing ? [`入口缺失: ${entryRel}`] : []),
    ...missingRefs.map((r) => `引用的本地资源不存在: ${r}`),
  ];

  // 文件哈希
  const checksums = copied
    .map((rel) => `${sha256File(path.join(webDir, rel))}  ${rel}`)
    .sort()
    .join('\n') + (copied.length ? '\n' : '');
  fs.writeFileSync(path.join(webDir, '..', 'checksums.sha256'), checksums);

  // release.json
  const release = {
    id: `${slug}-${ver}`,
    slug,
    version: ver,
    builtAt: new Date().toISOString(),
    engine: manifest.engine,
    entry: entryRel,
    targets: ['web'],
    sourceManifestHash: sha256File(gamePath),
    files: copied.length,
    ok: refErrors.length === 0,
  };
  fs.writeFileSync(path.join(webDir, '..', 'release.json'), JSON.stringify(release, null, 2));

  // validation-report.json
  fs.writeFileSync(
    path.join(webDir, '..', 'validation-report.json'),
    JSON.stringify({ ok: refErrors.length === 0, manifest: { ok, errors, warnings }, refErrors, checksumsFile: 'checksums.sha256' }, null, 2)
  );

  return { slug, version: ver, webDir, copied, manifest, refErrors, release };
}
