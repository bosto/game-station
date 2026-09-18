# 单行道大亨 (one-way-tycoon)

怪物沿单行道进攻,沿途布置机关改变其前进方式形成连锁,五分钟一局。

## 玩法与参数
- 操作:鼠标 / 触屏放置机关。
- 参数(`params.json`,已放宽):`startGold` 初始金币、`maxLives` 生命、`winTime` 守关时长、`maxTraps` 机关上限等。

## 已知问题
- 完整玩法循环与较长会话尚未实测。
- 封面/截图/操作说明文件待生成。

## 验证与发布
```bash
node packages/game-cli/cli.mjs check one-way-tycoon
node packages/game-cli/cli.mjs dev one-way-tycoon --port 4102
node packages/game-cli/cli.mjs build one-way-tycoon
node packages/game-cli/cli.mjs package one-way-tycoon
GAME_STATION_TOKEN=<令牌> node packages/game-cli/cli.mjs publish one-way-tycoon --publish
```
