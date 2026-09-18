# platform-bridge

统一平台能力接口(浏览器脚本,无依赖):`ready / gameplayStart / gameplayStop / pause / resume / save / load / showAd / rewardAd`。

- `local` 适配器:通用网页版实装(localStorage 存档、可见性暂停、广告明确不可用)。
- `itch / crazygames / poki` 适配器:桩,接入对应 SDK 后在 `adapters` 注册,并在**对应构建**里加载(通过 `window.__PLATFORM__` 标记)。
- 原则:**广告不可用时不得伪造"已完成奖励广告"**。

用法见 `index.js` 顶部注释。
