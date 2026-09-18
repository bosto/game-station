# 词林迷阵 (word-maze)

在汉字魔法森林中,通过组合/拆分汉字改变环境并推动剧情。例如‘日’+‘月’=‘明’可照亮道路。
核心循环:阅读故事 → 选择字词操作 → 观察反馈 → 推进章节。

## 玩法与参数
- 操作:鼠标 / 触屏点击汉字与字格。
- 参数(`params.json`,P1 补齐):`baseScore/comboBonus/maxCombo/startLives/timeLimit/particleCount/mergeCooldown/failPenalty`。
  - 说明:此前目录缺失 params.json,代码有默认回退但每次都会产生一次预期内 404;P1 已显式生成该文件。

## 已知问题
- 封面/截图/操作说明文件待生成。

## 验证与发布
```bash
node packages/game-cli/cli.mjs check word-maze
node packages/game-cli/cli.mjs dev word-maze --port 4103
node packages/game-cli/cli.mjs build word-maze
node packages/game-cli/cli.mjs package word-maze
GAME_STATION_TOKEN=<令牌> node packages/game-cli/cli.mjs publish word-maze --publish
```
