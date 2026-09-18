# 秘法拾荒者 (arcane-salvage)

Phaser 3 卡牌 / Roguelike:在坍塌之门中拾荒,管理生命/零件/卡组与遗物,本地自动存档。
原始单机站点曾独立部署(arcane-salvage.bosto.chat,Pages);P1 迁入 projects 统一管理。

## 技术栈
- Phaser 3.90(本地 `vendor/phaser.min.js`,无外部网络依赖)。
- `app.js` 为游戏逻辑;`index.html` 为入口(P1 已把 `/app.js`、`/vendor/phaser.min.js` 改为相对路径)。
- 设计文档归档:`store/design.html`。

## 已知问题
- 尚未在 game-station 发布(platforms.station = not-started)。
- 封面/截图/操作说明文件待生成。
- 需统一 Phaser 构建来源并核对第三方许可证。

## 验证与发布
```bash
node packages/game-cli/cli.mjs check arcane-salvage
node packages/game-cli/cli.mjs dev arcane-salvage --port 4104
node packages/game-cli/cli.mjs build arcane-salvage
node packages/game-cli/cli.mjs package arcane-salvage
GAME_STATION_TOKEN=<令牌> node packages/game-cli/cli.mjs publish arcane-salvage --publish
```
