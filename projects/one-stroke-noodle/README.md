# 一笔泡面 (one-stroke-noodle)

一笔画变面条:控制火候与时机,煮到 Q 弹状态用筷子夹出。慢火关从容练习,多关递进。

## 玩法与参数
- 操作:鼠标 / 触屏。
- 参数(`params.json`,已放宽):`round1Time/round1Heat/round1Need`、`round2*` 等多关时长/火候/过关碗数。

## 已知问题
- 触屏与横竖屏适配尚未实测。
- 封面/截图/操作说明文件待生成。

## 验证与发布
```bash
node packages/game-cli/cli.mjs check one-stroke-noodle
node packages/game-cli/cli.mjs dev one-stroke-noodle --port 4101
node packages/game-cli/cli.mjs build one-stroke-noodle
node packages/game-cli/cli.mjs package one-stroke-noodle
GAME_STATION_TOKEN=<令牌> node packages/game-cli/cli.mjs publish one-stroke-noodle --publish
```
