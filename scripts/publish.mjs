#!/usr/bin/env node
// 游戏发布器:把本地一个游戏目录发布到 game-station
// 供 DeepSeek Harness / Claude Code / 任意 agent 或脚本调用。
//
// 用法:
//   node scripts/publish.mjs <游戏目录> [选项]
//
// 选项:
//   --slug <slug>        URL 标识(默认取目录名,自动小写/连字符化)
//   --title <标题>        游戏标题(默认用 slug)
//   --description <...>  简介(可选)
//   --genre <类型>        品类(可选)
//   --source <来源>       发布者标识,如 dsh / claude(可选)
//   --publish            上传完成后立即公开试玩(playable=1)
//   --stage              上传到私密暂存目录,不改动线上旧版(需配合 --activate 生效)
//   --activate [版本]    原子激活暂存内容为线上新版本(旧版自动快照,可回滚)
//   --token <令牌>        管理员令牌;也可用环境变量 GAME_STATION_TOKEN
//   --url <地址>          服务地址(默认 http://127.0.0.1:3210)
//
// 原子发布示例(推荐):
//   GAME_STATION_TOKEN=abc node scripts/publish.mjs ./games/foo --title "Foo" --stage \
//     && GAME_STATION_TOKEN=abc node scripts/publish.mjs --slug foo --activate v2 --publish
// 说明:--stage 阶段线上仍是旧版,上传中断不影响旧版;--activate 一次性切换。
'use strict';
import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (['publish', 'stage'].includes(key)) { opts[key] = true; continue; }
      if (key === 'activate') {
        opts.activate = true;
        if (next !== undefined && !next.startsWith('--')) { opts['activate-version'] = next; i++; }
        continue;
      }
      if (next === undefined || next.startsWith('--')) throw new Error(`缺少参数值: --${key}`);
      opts[key] = next;
      i++;
    } else {
      opts._.push(a);
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dir = opts._[0];
  const onlyActivate = opts.activate && !dir;
  if (!onlyActivate && (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory())) {
    throw new Error(`请传入一个存在的游戏目录(仅 --activate 时可不传目录),例如: node scripts/publish.mjs ./games/my-game`);
  }

  const base = String(opts.url || process.env.GAME_STATION_URL || 'http://127.0.0.1:3210').replace(/\/+$/, '');
  const token = opts.token || process.env.GAME_STATION_TOKEN || '';
  const slug = String(opts.slug || (dir ? path.basename(path.resolve(dir)) : ''))
    .toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'game';
  const title = String(opts.title || slug).trim();
  const body = {
    title,
    description: opts.description || '',
    genre: opts.genre || '未分类',
    source: opts.source || '',
  };
  const headers = { 'Content-Type': 'application/json', ...(token ? { 'x-admin-token': token } : {}) };

  const call = async (url, method, opts2 = {}) => {
    const res = await fetch(url, { method, headers, ...opts2 });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch (e) {}
    if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${data?.message || text.slice(0, 200)}`);
    return data;
  };

  // 仅激活模式:直接激活已有暂存内容
  if (onlyActivate) {
    const version = opts['activate-version'] || opts.version || '';
    const r = await call(`${base}/api/games/${slug}/activate`, 'POST', {
      body: JSON.stringify({ version, note: opts.note || 'agent activate' }),
    });
    console.log(`✓ 已激活暂存内容: ${slug} (version=${r.version}, releaseId=${r.releaseId})`);
    if (opts.publish) {
      await call(`${base}/api/games/${slug}`, 'PATCH', { body: JSON.stringify({ playable: true }) });
      console.log('✓ 已公开试玩 (playable=1)');
    }
    console.log(`\n✅ 发布完成: ${base}/play/${slug}`);
    return;
  }

  // 1) 创建或更新游戏记录
  try {
    await call(`${base}/api/games/${slug}`, 'PATCH', { body: JSON.stringify(body) });
    console.log(`✓ 更新已有游戏: ${slug}`);
  } catch (e) {
    if (!String(e.message).includes('404')) throw e;
    const data = await call(`${base}/api/games`, 'POST', { body: JSON.stringify({ slug, ...body }) });
    console.log(`✓ 创建游戏: ${slug} (id=${data.id})`);
  }

  // 2) 上传目录下所有文件(--stage 时写入私密暂存目录,不动线上)
  const skip = new Set(['node_modules', '.git', '.DS_Store', '__pycache__']);
  const files = [];
  (function walk(d, prefix) {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      if (skip.has(ent.name) || ent.name.startsWith('.')) continue;
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(path.join(d, ent.name), rel);
      else files.push({ rel, abs: path.join(d, ent.name) });
    }
  })(dir, '');
  // 排除 .bak* 备份文件(发布内容不应包含旧备份)
  const clean = files.filter((f) => !/\.bak(?:-\d+)?$/.test(f.rel));
  if (clean.length !== files.length) {
    console.log(`  ⏭ 跳过 ${files.length - clean.length} 个备份文件(.bak*)`);
  }

  // 上传模式:--activate 需要先暂存(--stage 或 --activate 都写入私密暂存,不动线上)
  const useStaging = opts.stage || opts.activate;
  for (const f of clean) {
    const stageQ = useStaging ? '?stage=1' : '';
    const res = await fetch(`${base}/api/games/${slug}/files/${f.rel}${stageQ}`, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/octet-stream' },
      body: fs.readFileSync(f.abs),
    });
    if (!res.ok) throw new Error(`上传失败 ${f.rel}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    console.log(`  ↑ ${f.rel} (${fs.statSync(f.abs).size} B)`);
  }
  if (!clean.length) throw new Error('目录里没有可上传的文件');

  // 3) --activate:原子激活暂存内容
  if (opts.activate) {
    const version = opts['activate-version'] || opts.version || '';
    const r = await call(`${base}/api/games/${slug}/activate`, 'POST', {
      body: JSON.stringify({ version, note: opts.note || 'agent activate' }),
    });
    console.log(`✓ 已激活暂存内容: ${slug} (version=${r.version}, releaseId=${r.releaseId})`);
  }

  // 4) 可选:公开试玩
  if (opts.publish) {
    await call(`${base}/api/games/${slug}`, 'PATCH', { body: JSON.stringify({ playable: true }) });
    console.log('✓ 已公开试玩 (playable=1)');
  }

  console.log(`\n✅ 发布完成: ${base}/play/${slug}  (共 ${clean.length} 个文件, ${useStaging && !opts.activate ? '已暂存(未激活)' : '已上线'})`);
}

main().catch((e) => {
  console.error('❌ ' + e.message);
  process.exit(1);
});
