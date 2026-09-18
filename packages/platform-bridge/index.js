// platform-bridge(P3 骨架):统一平台能力接口
// 提供 ready / gameplayStart / gameplayStop / pause / resume / save / load / showAd / rewardAd。
// 通用网页版本用 local 适配器(本地实现,广告明确"不支持");平台 SDK 仅在对应构建加载。
// 原则:广告不可用时不得伪造"已完成奖励广告"。
//
// 游戏内用法:
//   <script src="./platform-bridge/index.js"></script>
//   PlatformBridge.init({ autoDetect: true });
//   PlatformBridge.gameplayStart(); ... PlatformBridge.gameplayStop();
//   const ok = await PlatformBridge.showAd('reward'); // 不可用则 { available:false }

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PlatformBridge = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---- 本地/通用网页适配器 ----
  const localAdapter = {
    id: 'local',
    // 在独立页面中,可见性变化即代表可暂停/恢复
    onVisibility(cb) {
      const fn = () => cb(document.visibilityState === 'hidden' ? 'pause' : 'resume');
      document.addEventListener('visibilitychange', fn);
      return () => document.removeEventListener('visibilitychange', fn);
    },
    save(key, data) {
      try { localStorage.setItem('pb:' + key, JSON.stringify(data)); return true; }
      catch (e) { return false; }
    },
    load(key) {
      try { const v = localStorage.getItem('pb:' + key); return v ? JSON.parse(v) : null; }
      catch (e) { return null; }
    },
    clear(key) { localStorage.removeItem('pb:' + key); },
    // 本地无广告,明确不可用(不伪造奖励)
    showAd() { return Promise.resolve({ available: false, reason: 'no-ad-network' }); },
    rewardAd() { return Promise.resolve({ available: false, reason: 'no-ad-network' }); },
  };

  // ---- 平台适配器注册表(对应构建加载;未实装返回 null) ----
  const adapters = { local: localAdapter, itch: null, crazygames: null, poki: null };

  function detect() {
    // 构建标记:window.__PLATFORM__ 或 game.json 注入;默认 local
    return window.__PLATFORM__ || 'local';
  }

  const api = {
    adapters,
    current: null,
    init(opts) {
      opts = opts || {};
      const id = opts.adapter || (opts.autoDetect !== false ? detect() : 'local');
      api.current = adapters[id] || localAdapter;
      if (opts.autoDetect !== false && opts.onVisibility !== false && api.current.onVisibility) {
        api._unvis = api.current.onVisibility((s) => api.emit(s));
      }
      api.emit('ready');
      return api.current;
    },
    _listeners: {},
    on(ev, fn) { (api._listeners[ev] = api._listeners[ev] || []).push(fn); return () => api.off(ev, fn); },
    off(ev, fn) { api._listeners[ev] = (api._listeners[ev] || []).filter((f) => f !== fn); },
    emit(ev, ...args) { (api._listeners[ev] || []).forEach((f) => { try { f(...args); } catch (e) {} }); },
    ready() { return api.current ? true : !!api.init(); },
    gameplayStart() { api.emit('gameplayStart'); },
    gameplayStop() { api.emit('gameplayStop'); },
    pause() { api.emit('pause'); },
    resume() { api.emit('resume'); },
    save(key, data) { return api.current ? api.current.save(key, data) : false; },
    load(key) { return api.current ? api.current.load(key) : null; },
    clear(key) { if (api.current) api.current.clear(key); },
    showAd(placement) { return api.current ? api.current.showAd(placement) : Promise.resolve({ available: false }); },
    rewardAd() { return api.current ? api.current.rewardAd() : Promise.resolve({ available: false }); },
    setAdapter(id) {
      api.current = adapters[id] || localAdapter;
      return api.current;
    },
  };

  return api;
});
