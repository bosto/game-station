// 游戏发布站 - 管理后台脚本(精简版)
'use strict';

const $ = (id) => document.getElementById(id);
const TOKEN_KEY = 'gs_admin_token';
let token = localStorage.getItem(TOKEN_KEY) || '';
let currentSlug = null;

// ---------- 基础请求 ----------
async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (token) headers['x-admin-token'] = token;
  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401) { showLogin(); throw new Error('unauthorized'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || res.status);
  return data;
}

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2200);
}

// ---------- 登录 ----------
function showLogin() { $('login-mask').classList.add('show'); }
function hideLogin() { $('login-mask').classList.remove('show'); }
async function submitLogin() {
  $('login-error').style.display = 'none';
  try {
    const r = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: $('login-user').value, password: $('login-pass').value }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.message || '登录失败');
    token = d.token;
    localStorage.setItem(TOKEN_KEY, token);
    hideLogin();
    await init();
  } catch (e) {
    $('login-error').textContent = '⚠️ ' + e.message;
    $('login-error').style.display = 'block';
  }
}
function logoutAdmin() {
  localStorage.removeItem(TOKEN_KEY);
  token = '';
  location.reload();
}

// ---------- 标签页 ----------
document.querySelectorAll('.tab-btn').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((x) => x.classList.remove('active'));
    document.querySelectorAll('.tab-page').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    $(`tab-${b.dataset.tab}`).classList.add('active');
    if (b.dataset.tab === 'games') loadGames();
    else loadSettings();
  });
});

// ---------- 概览 ----------
async function loadOverview() {
  const s = await api('/api/stats/overview');
  $('ov-total').textContent = s.totalGames;
  $('ov-live').textContent = s.liveGames;
  $('ov-plays').textContent = s.totalPlays;
  $('ov-today').textContent = s.todayPlays;
}

// ---------- 游戏列表 ----------
async function loadGames() {
  try {
    const d = await api('/api/games');
    $('game-empty').style.display = d.games.length ? 'none' : 'block';
    $('game-tbody').innerHTML = d.games.map((g) => `
      <tr>
        <td><b>${esc(g.title)}</b><div style="color:var(--dim);font-size:12px">/${g.slug} · ${esc((g.description || '').slice(0, 40))}</div></td>
        <td>${esc(g.genre || '-')}</td>
        <td style="color:var(--dim)">${esc(g.source || '-')}</td>
        <td style="color:var(--accent2)">🔥 ${g.plays}</td>
        <td>${g.playable
          ? '<span class="pill live">公开试玩</span>'
          : '<span class="pill audit">未公开</span>'}</td>
        <td style="white-space:nowrap">
          <button class="btn sm primary" onclick="openDetail('${g.slug}')">详情</button>
          ${g.playable
            ? `<button class="btn sm" onclick="togglePlayable('${g.slug}', 0)">下架</button>`
            : `<button class="btn sm green" onclick="togglePlayable('${g.slug}', 1)">公开</button>`}
        </td>
      </tr>`).join('');
    await loadOverview();
  } catch (e) { toast('加载失败: ' + e.message); }
}

async function togglePlayable(slug, playable) {
  await api(`/api/games/${slug}`, { method: 'PATCH', body: JSON.stringify({ playable }) });
  toast(playable ? '已公开试玩 ✅' : '已下架');
  loadGames();
}

// ---------- 创建 ----------
function openCreate() { $('create-mask').classList.add('show'); }
function closeCreate() { $('create-mask').classList.remove('show'); }
async function createGame() {
  const title = $('c-title').value.trim();
  if (!title) return toast('请填写标题');
  await api('/api/games', {
    method: 'POST',
    body: JSON.stringify({ title, slug: $('c-slug').value, genre: $('c-genre').value, description: $('c-desc').value }),
  });
  closeCreate();
  ['c-title', 'c-slug', 'c-genre', 'c-desc'].forEach((i) => ($(i).value = ''));
  toast('创建成功,去详情里上传游戏文件吧');
  loadGames();
}

// ---------- 详情 ----------
async function openDetail(slug) {
  currentSlug = slug;
  const d = await api(`/api/games/${slug}`);
  const g = d.game;
  $('d-title').textContent = '🎮 ' + g.title;
  $('d-f-title').value = g.title;
  $('d-f-genre').value = g.genre || '';
  $('d-f-source').value = g.source || '';
  $('d-f-desc').value = g.description || '';
  $('d-f-playable').checked = g.playable;
  $('d-play-url').textContent = `/play/${g.slug}`;
  $('d-file-url').textContent = `/g/${g.slug}/index.html`;
  $('d-html').value = '';
  $('d-plays').textContent = g.plays;

  $('d-files').innerHTML = d.files.length
    ? d.files.map((f) => `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
        <span style="flex:1;font-family:ui-monospace,Menlo,monospace;font-size:12px">📄 ${esc(f.path)}</span>
        <span style="color:var(--dim);font-size:11px">${fmtSize(f.bytes)}</span>
        <button class="btn sm red" onclick="deleteFile(${jattr(f.path)})">删</button>
      </div>`).join('')
    : '<div style="color:var(--dim);font-size:13px;text-align:center;padding:14px">暂无文件,先上传 index.html</div>';

  const bars = d.stats || [];
  const max = Math.max(1, ...bars.map((b) => b.plays));
  $('d-bars').innerHTML = bars.length
    ? bars.map((b) => `<div class="bar" style="height:${Math.max(4, (b.plays / max) * 100)}%">
        <span class="day">${b.date.slice(5)}</span><span class="val">${b.plays}</span></div>`).join('')
    : '<div style="color:var(--dim);font-size:12px">暂无数据</div>';

  $('detail-mask').classList.add('show');
  loadReleases(slug);
}
function closeDetail() { $('detail-mask').classList.remove('show'); currentSlug = null; }

// ---------- 版本与交付物(P2) ----------
function relLink(path) {
  return path + (path.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token);
}
async function loadReleases(slug) {
  const box = $('d-releases');
  if (!slug) return;
  try {
    const d = await api(`/api/games/${slug}/releases`);
    const rels = d.releases || [];
    if (!rels.length) {
      box.innerHTML = '暂无版本记录。用 <code>game publish</code> 或 <code>POST /activate</code> 发布后会出现。';
      return;
    }
    box.innerHTML = rels.map((r) => {
      const arts = (r.artifacts || []).map((a) =>
        `<a class="art-link" target="_blank" href="${relLink(`/api/games/${slug}/releases/${r.id}/artifacts/${a.file}`)}" style="color:#9db0ff">⬇ ${a.file}</a>`).join('');
      return `<div style="display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid var(--line);border-radius:10px;margin-bottom:8px;flex-wrap:wrap">
        <b style="min-width:60px">${esc(r.version)}</b>
        <span style="color:var(--dim);font-size:12px">#${r.id} · ${(r.created_at || '').slice(0, 19).replace('T', ' ')}</span>
        ${r.hasSnapshot ? '<span style="color:#9db0ff;font-size:12px;border:1px solid #2b3b55;border-radius:20px;padding:2px 8px">可回滚</span>' : '<span style="color:#7ee081;font-size:12px;border:1px solid #2b4a35;border-radius:20px;padding:2px 8px">当前</span>'}
        <span style="color:var(--dim);font-size:12px">${esc(r.note || '')}</span>
        <span class="spacer"></span>
        <button class="btn sm" onclick="previewRelease(${r.id})">👁 预览</button>
        ${r.hasSnapshot ? `<button class="btn sm" style="border-color:#8a6d1f;color:#e8c45a" onclick="rollbackTo(${r.id})">↩ 回滚</button>` : ''}
        ${arts}
      </div>`;
    }).join('');
  } catch (e) {
    box.innerHTML = '⚠️ 加载失败: ' + esc(e.message);
  }
}
async function previewRelease(releaseId) {
  try {
    const d = await api(`/api/games/${currentSlug}/releases/${releaseId}/preview-session`, { method: 'POST' });
    window.open(d.previewUrl, '_blank');
  } catch (e) { toast('预览失败: ' + e.message); }
}
async function previewDraft() {
  try {
    const d = await api(`/api/games/${currentSlug}/preview-session`, { method: 'POST' });
    window.open(d.previewUrl, '_blank');
  } catch (e) { toast('暂存草稿预览失败: ' + (e.message || '')); }
}
async function rollbackTo(releaseId) {
  if (!confirm('回滚到该版本?当前线上内容会切换到该版本。')) return;
  try {
    const d = await api(`/api/games/${currentSlug}/rollback`, { method: 'POST', body: JSON.stringify({ releaseId }) });
    toast('已回滚到 ' + d.restored + ' ✅');
    loadReleases(currentSlug);
  } catch (e) { toast('回滚失败: ' + e.message); }
}

async function saveDetail() {
  await api(`/api/games/${currentSlug}`, {
    method: 'PATCH',
    body: JSON.stringify({
      title: $('d-f-title').value,
      genre: $('d-f-genre').value,
      source: $('d-f-source').value,
      description: $('d-f-desc').value,
      playable: $('d-f-playable').checked,
    }),
  });
  toast('已保存');
  closeDetail();
  loadGames();
}

async function saveHtml() {
  const html = $('d-html').value;
  if (!html.trim()) return toast('内容为空');
  const res = await fetch(`/api/games/${currentSlug}/files/index.html`, {
    method: 'PUT',
    headers: { 'x-admin-token': token, 'Content-Type': 'text/html' },
    body: html,
  });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    return toast('保存失败: ' + (d.message || res.status));
  }
  toast('index.html 已保存 ✅');
  $('d-html').value = '';
  openDetail(currentSlug);
}

async function deleteFile(rel) {
  if (!confirm(`删除文件 ${rel}?`)) return;
  await api(`/api/games/${currentSlug}/files/${rel}`, { method: 'DELETE' });
  toast('已删除');
  openDetail(currentSlug);
}

async function deleteGame() {
  if (!confirm(`确定删除游戏「${currentSlug}」及其全部文件?不可恢复!`)) return;
  await api(`/api/games/${currentSlug}`, { method: 'DELETE' });
  toast('已删除');
  closeDetail();
  loadGames();
}

// ---------- 设置 ----------
async function loadSettings() {
  const c = await api('/api/config');
  $('s-user').value = c.adminUser;
  $('s-token').value = c.adminToken;
}
function copyToken() {
  navigator.clipboard.writeText($('s-token').value).then(() => toast('令牌已复制'));
}
async function regenerateToken() {
  if (!confirm('重新生成令牌会使所有已登录会话失效,确定?')) return;
  const d = await api('/api/config', { method: 'POST', body: JSON.stringify({ regenerateToken: true }) });
  token = d.adminToken;
  localStorage.setItem(TOKEN_KEY, token);
  $('s-token').value = d.adminToken;
  toast('已生成新令牌');
}
async function changePassword() {
  await api('/api/auth/change-password', {
    method: 'POST',
    body: JSON.stringify({ oldPassword: $('s-old-pass').value, newPassword: $('s-new-pass').value }),
  });
  $('s-old-pass').value = $('s-new-pass').value = '';
  toast('密码已修改 ✅');
}

// ---------- 工具 ----------
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// 供 onclick 属性使用:HTML 转义后的 JSON 字符串字面量
function jattr(s) {
  return esc(JSON.stringify(String(s ?? '')));
}
function fmtSize(n) {
  return n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + ' MB' : n >= 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' B';
}

// ---------- 启动 ----------
async function init() {
  try {
    await api('/api/auth/status');
    hideLogin();
    loadGames();
  } catch (e) {
    showLogin();
  }
}
init();
