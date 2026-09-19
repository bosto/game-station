#!/usr/bin/env node
// 发布流程冒烟测试:验证 创建→上传→公开→访问→计数→删除 全链路,
// 以及 P0 新增的:未授权/错误令牌上传被拒、暂存原子发布、回滚。
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
let failures = 0;

async function call(path, opts = {}) {
  const res = await fetch(base + path, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) {}
  return { status: res.status, data, text };
}

// 自定义请求头调用(用于无令牌 / 错误令牌的鉴权测试)
async function rawCall(path, opts = {}, headers = {}) {
  const res = await fetch(base + path, { ...opts, headers });
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

  // 2. 上传 v1:index.html + 子目录资源
  const v1 = `<h1>${slug}-V1</h1>`;
  const v2 = `<h1>${slug}-V2</h1>`;
  r = await call(`/api/games/${slug}/files/index.html`, {
    method: 'PUT', headers: { 'Content-Type': 'text/html' }, body: v1,
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

  // 3.5 先公开试玩,使 /g/<slug>/ 本体可被访问(供后续暂存/激活/回滚断言)
  r = await call(`/api/games/${slug}`, { method: 'PATCH', body: JSON.stringify({ playable: true }) });
  check('公开试玩(前置)', r.status === 200 && r.data?.ok, r.text.slice(0, 120));

  // 4. 鉴权防护:无令牌 / 错误令牌上传必须被拒,且不写入文件
  r = await rawCall(`/api/games/${slug}/files/unauth.txt`, {
    method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: 'x',
  }, {});
  check('未授权上传被拒(401)', r.status === 401, `status=${r.status}`);
  r = await rawCall(`/api/games/${slug}/files/unauth2.txt`, {
    method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: 'x',
  }, { 'x-admin-token': 'wrong-token' });
  check('错误令牌上传被拒(401)', r.status === 401, `status=${r.status}`);
  r = await call(`/api/games/${slug}/files`);
  const paths2 = (r.data?.files || []).map((f) => f.path);
  check('未授权上传未写入文件', r.status === 200 && !paths2.includes('unauth.txt') && !paths2.includes('unauth2.txt'), JSON.stringify(paths2));

  // 5. 暂存原子发布:stage 上传新版本,不影响线上旧版
  r = await call(`/api/games/${slug}/files/index.html?stage=1`, {
    method: 'PUT', headers: { 'Content-Type': 'text/html' }, body: v2,
  });
  check('暂存上传新版本', r.status === 200 && r.data?.staged === true, r.text.slice(0, 120));
  r = await call(`/api/games/${slug}/files/assets/new.txt?stage=1`, {
    method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: 'new',
  });
  check('暂存上传新资源', r.status === 200 && r.data?.staged === true, r.text.slice(0, 120));
  r = await call(`/g/${slug}/index.html`);
  check('暂存期间线上仍是旧版', r.status === 200 && r.text.includes('V1'), `status=${r.status}`);
  // 暂存内容不应被公网访问
  r = await call(`/g/${slug}/index.html?stage=1`);
  check('暂存内容不公开', r.status === 200 && !r.text.includes('V2'), `status=${r.status}`);
  // 草稿预览会话:可预览暂存的新版,不影响线上旧版
  r = await call(`/api/games/${slug}/preview-session`, { method: 'POST' });
  check('创建草稿预览会话', r.status === 200 && r.data?.ok && /^\/preview\/[a-f0-9]{32}\//.test(r.data?.previewUrl || ''), r.text.slice(0, 120));
  const draftUrl = r.data?.previewUrl;
  if (draftUrl) {
    r = await rawCall(`${draftUrl}index.html`, {}, {});
    check('草稿预览可见暂存新版', r.status === 200 && r.text.includes('V2'), `status=${r.status}`);
    r = await rawCall(`${draftUrl}assets/new.txt`, {}, {});
    check('草稿预览子资源可访问(修复 403)', r.status === 200 && r.text === 'new', `status=${r.status}`);
  }

  // 6. 激活 → 线上切到新版本,并生成 release 快照
  r = await call(`/api/games/${slug}/activate`, {
    method: 'POST', body: JSON.stringify({ version: 'v2', note: 'ci atomic publish' }),
  });
  check('激活暂存发布', r.status === 200 && r.data?.ok && r.data.releaseId, r.text.slice(0, 120));
  const releaseId = r.data?.releaseId;
  r = await call(`/g/${slug}/index.html`);
  check('激活后线上是新版', r.status === 200 && r.text.includes('V2'), `status=${r.status}`);

  // 7. 回滚到 v1 release
  r = await call(`/api/games/${slug}/releases`);
  check('release 列表', r.status === 200 && Array.isArray(r.data?.releases) && r.data.releases.length >= 1, r.text.slice(0, 120));
  if (releaseId) {
    r = await call(`/api/games/${slug}/rollback`, {
      method: 'POST', body: JSON.stringify({ releaseId }),
    });
    check('回滚到旧版本', r.status === 200 && r.data?.ok, r.text.slice(0, 120));
    r = await call(`/g/${slug}/index.html`);
    check('回滚后线上是旧版', r.status === 200 && r.text.includes('V1'), `status=${r.status}`);
  } else {
    check('回滚到旧版本', false, '无 releaseId');
  }

  // 7.5 P2: 版本预览会话(短时 token,子资源可访问)与交付物下载
  if (releaseId) {
    r = await call(`/api/games/${slug}/releases/${releaseId}/preview-session`, { method: 'POST' });
    check('创建预览会话', r.status === 200 && r.data?.ok && /^\/preview\/[a-f0-9]{32}\//.test(r.data?.previewUrl || ''), r.text.slice(0, 120));
    const previewUrl = r.data?.previewUrl;
    if (previewUrl) {
      r = await rawCall(`${previewUrl}index.html`, {}, {});
      check('预览会话可访问旧版内容', r.status === 200 && r.text.includes('V1'), `status=${r.status}`);
    }
    // 无效 token 应 410
    r = await rawCall('/preview/00000000000000000000000000000000/index.html', {}, {});
    check('无效预览 token 被拒(410)', r.status === 410, `status=${r.status}`);
    // 交付物:冒烟未构建,期望 404(而非 500);releases 列表应含 hasSnapshot
    r = await call(`/api/games/${slug}/releases/${releaseId}/artifacts/web.zip`);
    check('未构建交付物返回 404', r.status === 404, `status=${r.status}`);
    r = await call(`/api/games/${slug}/releases`);
    const rels = r.data?.releases || [];
    check('releases 记录新版本行', r.status === 200 && rels[0]?.version === 'v2', r.text.slice(0, 120));
    check('releases 含可回滚快照', rels.some((x) => x.hasSnapshot === true), r.text.slice(0, 120));
    r = await call(`/api/games/${slug}/deployments`);
    const deps = r.data?.deployments || [];
    check('deployments 记录激活事件', r.status === 200 && deps.some((x) => x.action === 'activate' && x.version === 'v2'), r.text.slice(0, 120));
  }

  // 8. 公开列表可见(playable 已在前面设置)
  r = await call('/api/games?public=1');
  check('公开列表可见', r.status === 200 && (r.data?.games || []).some((g) => g.slug === slug));

  // 9. 游戏本体可访问
  r = await call(`/g/${slug}/index.html`);
  check('游戏本体 200 且内容正确', r.status === 200 && (r.text.includes('V1') || r.text.includes('V2')), `status=${r.status}`);

  // 10. 试玩计数
  r = await call(`/api/games/${slug}/play`, { method: 'POST' });
  check('试玩计数', r.status === 200 && r.data?.total >= 1, r.text.slice(0, 120));

  // 11. 详情(文件 + 统计)
  r = await call(`/api/games/${slug}`);
  check('详情接口', r.status === 200 && r.data?.game?.plays >= 1 && r.data?.files?.length >= 2, r.text.slice(0, 120));

  // 12. 路径越界防护(Express 可能在路由层直接规范化拒绝(404),也可能由处理器拒绝(400),两者都安全)
  r = await call(`/api/games/${slug}/files/%2e%2e/evil.txt`, { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: 'x' });
  check('路径越界被拒', r.status === 400 || r.status === 404, `status=${r.status}`);

  // 13. 删除游戏(清理)
  r = await call(`/api/games/${slug}`, { method: 'DELETE' });
  check('删除游戏', r.status === 200 && r.data?.ok, r.text.slice(0, 120));

  // 14. 删除后公开列表不可见
  r = await call('/api/games?public=1');
  check('清理完成', !(r.data?.games || []).some((g) => g.slug === slug));

  console.log(failures ? `\n❌ 冒烟测试失败: ${failures} 项` : '\n✅ 冒烟测试全部通过');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error('❌ 冒烟测试异常:', e.message);
  process.exit(1);
});
