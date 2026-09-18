// 平台校验器(P3):按各平台要求校验构建产物。
// 当前实现 itch.io HTML5 校验;CrazyGames / Poki 待 SDK 集成后扩展。
'use strict';
import fs from 'node:fs';
import path from 'node:path';

// itch.io HTML5 上传要求(https://itch.io/docs/creators/html5):
//   - ZIP 根目录直接包含 index.html 与运行资源,资源用相对路径
//   - 避免外部 CDN 依赖;如需可按平台规则处理
//   - 对文件数量、路径长度与大小有限制(作为可更新规则)
const ITCH_LIMITS = {
  maxFiles: 2000,
  maxPathLen: 255,
  maxTotalBytes: 512 * 1024 * 1024, // 512MB(宽松,随平台更新)
};

export function checkItch({ manifest, webDir }) {
  const errors = [];
  const warnings = [];
  const entry = manifest.entry || 'index.html';
  const entryAbs = path.join(webDir, entry);
  if (!fs.existsSync(entryAbs)) errors.push(`itch: 缺少入口 ${entry}(ZIP 根目录需直接包含 index.html)`);

  // 文件数量 / 路径长度 / 总大小
  let count = 0, total = 0, maxPath = 0;
  (function walk(d, prefix) {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(path.join(d, ent.name), rel);
      else { count++; total += fs.statSync(path.join(d, ent.name)).size; maxPath = Math.max(maxPath, rel.length); }
    }
  })(webDir, '');
  if (count > ITCH_LIMITS.maxFiles) errors.push(`itch: 文件数 ${count} 超过上限 ${ITCH_LIMITS.maxFiles}`);
  if (maxPath > ITCH_LIMITS.maxPathLen) errors.push(`itch: 路径最长 ${maxPath} 字符,超过 ${ITCH_LIMITS.maxPathLen}`);
  if (total > ITCH_LIMITS.maxTotalBytes) errors.push(`itch: 包大小 ${total} 超过上限`);
  warnings.push(`itch: ${count} 个文件,总 ${(total / 1024).toFixed(1)} KB`);

  // 外部依赖检查:manifest 声明的 externalNetwork 非空即警告
  if ((manifest.externalNetwork || []).length) {
    warnings.push(`itch: 存在外部网络依赖 [${manifest.externalNetwork.join(', ')}],建议内联或本地化`);
  }
  // 绝对路径检查(基于入口引用的启发式)
  if (fs.existsSync(entryAbs)) {
    const html = fs.readFileSync(entryAbs, 'utf8');
    for (const m of html.matchAll(/(?:src|href)\s*=\s*["'](\/[^"']*)["']/g)) {
      errors.push(`itch: 入口引用了绝对路径 "${m[1]}",必须改为相对路径`);
    }
  }
  // iframe 嵌入相关:提示平台审核以 iframe 运行游戏
  warnings.push('itch: 平台以 iframe 运行游戏,请勿在游戏内设置 frame-busting/X-Frame-Options');
  return { platform: 'itch', ok: errors.length === 0, errors, warnings };
}

// 平台状态机(与 game.json platforms[].status 一致)
export const PLATFORM_STATUS = ['not-started', 'adapting', 'ready', 'submitted', 'reviewing', 'live'];

export function checkPlatformStatus(manifest) {
  const warnings = [];
  for (const [p, cfg] of Object.entries(manifest.platforms || {})) {
    if (!PLATFORM_STATUS.includes(cfg.status)) warnings.push(`platforms.${p}.status="${cfg.status}" 非法,应为 ${PLATFORM_STATUS.join('/')}`);
    if (cfg.status !== 'not-started' && cfg.status !== 'adapting' && !cfg.projectId) {
      warnings.push(`platforms.${p}: 状态 ${cfg.status} 但缺少 projectId`);
    }
    if (cfg.status === 'live' || cfg.status === 'reviewing' || cfg.status === 'submitted') {
      warnings.push(`platforms.${p}=${cfg.status}: 本地通过不等于平台审核通过,需以平台官方状态为准`);
    }
  }
  return warnings;
}
