#!/usr/bin/env node
// 发布流程冒烟测试:验证 创建→上传→公开→访问→计数→删除 全链路
// 供 CI(GitHub Actions)与本地开发使用;测试游戏会自动清理,不污染线上数据。
//
// 用法:
//   node scripts/smoke.mjs --token <管理员令牌> [--url http://127.0.0.1:3210]
//   (token 也可用环境变量 GAME_STATION_TOKEN)
'use strict';

const args = process.argv.slice(2);
const pick = (key, fallback) => {
  const i = args.indexOf(`--${key}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const base = String(pick('url', process.env.GAME_STATION_URL || 'http://127.0.0.1:3210')).replace(/\/+$/, '');
const token = pick('token', process.env.GAME_STATION_TOKEN || '');
if (!token) {
  console.error('❌ 需要 --token(或环境变量 GAME_STATION_TOKEN)');
  process.exit(1);
}

const H = { 'Content-Type': 'application/json', 'x-admin-token': token };
const slug = `ci-smoke-${Date.now().toString(36)}`;
const MARKER = `smoke-${slug}`;
let failures = 0;

async function call(path, opts = {}) {
  const res = await fetch(base + path, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) {}
  return { status: res.status, data, text };
}

function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name} ${detail}`);
  }
}

async function main() {
  console.log(`冒烟测试 → ${base} (slug: ${slug})`);

  // 1. 创建游戏
  let r = await call('/api/games', {
    method: 'POST',
    body: JSON.stringify({ slug, title: 'CI 冒烟测试', genre: '测试', source: 'ci' }),
  });
  check('创建游戏', r.status === 200 && r.data?.ok && r.data.slug === slug, r.text.slice(0, 120));

  // 2. 上传 index.html + 子目录资源
  const html = `<!DOCTYPE html><html><head><title>${MARKER}</title></head><body><h1>${MARKER}</h1></body></html>`;
  r = await call(`/api/games/${slug}/files/index.html`, {
    method: 'PUT', headers: { 'Content-Type': 'text/html' }, body: html,
  });
  check('上传 index.html', r.status === 200 && r.data?.ok && r.data.bytes > 0, r.text.slice(0, 120));

  r = await call(`/api/games/${slug}/files/assets/note.txt`, {
    method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: 'hello',
  });
  check('上传子目录资源', r.status === 200 && r.data?.ok, r.text.slice(0, 120));

  // 3. 文件列表
  r = await call(`/api/games/${slug}/files`);
  const paths = (r.data?.files || []).map((f) => f.path);
  check('文件列表', r.status === 200 && paths.includes('index.html') && paths.includes('assets/note.txt'), JSON.stringify(paths));

  // 4. 公开试玩
  r = await call(`/api/games/${slug}`, { method: 'PATCH', body: JSON.stringify({ playable: true }) });
  check('公开试玩', r.status === 200 && r.data?.ok, r.text.slice(0, 120));

  // 5. 公开列表可见
  r = await call('/api/games?public=1');
  check('公开列表可见', r.status === 200 && (r.data?.games || []).some((g) => g.slug === slug));

  // 6. 游戏本体可访问
  r = await call(`/g/${slug}/index.html`);
  check('游戏本体 200 且内容正确', r.status === 200 && r.text.includes(MARKER), `status=${r.status}`);

  // 7. 试玩计数
  r = await call(`/api/games/${slug}/play`, { method: 'POST' });
  check('试玩计数', r.status === 200 && r.data?.total >= 1, r.text.slice(0, 120));

  // 8. 详情(文件 + 统计)
  r = await call(`/api/games/${slug}`);
  check('详情接口', r.status === 200 && r.data?.game?.plays >= 1 && r.data?.files?.length === 2, r.text.slice(0, 120));

  // 9. 路径越界防护
  r = await call(`/api/games/${slug}/files/%2e%2e/evil.txt`, { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: 'x' });
  check('路径越界被拒', r.status === 400, `status=${r.status}`);

  // 10. 删除游戏(清理)
  r = await call(`/api/games/${slug}`, { method: 'DELETE' });
  check('删除游戏', r.status === 200 && r.data?.ok, r.text.slice(0, 120));

  // 11. 删除后公开列表不可见
  r = await call('/api/games?public=1');
  check('清理完成', !(r.data?.games || []).some((g) => g.slug === slug));

  console.log(failures ? `\n❌ 冒烟测试失败: ${failures} 项` : '\n✅ 冒烟测试全部通过');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error('❌ 冒烟测试异常:', e.message);
  process.exit(1);
});
