# 苹果丰收 (apple-catcher)

移动篮子接住苹果得分;毒苹果扣血、炸弹大扣血;连击窗口内连续接苹果保持连击加分。

## 玩法与参数
- 操作:鼠标移动 / 触屏拖动控制篮子。
- 参数(`params.json`):`lives` 生命、`startSpeed/maxSpeed/speedRamp` 下落速度、`spawnGap/minSpawnGap` 出果密度、`appleScore/goldScore/comboTime` 计分、`badCost/bombCost` 扣血。

## 已知问题
- 尚未进行真实浏览器玩法实测(开始/操作/结束/重开)。
- 封面/截图/操作说明文件待生成。

## 验证与发布
```bash
node packages/game-cli/cli.mjs check apple-catcher
node packages/game-cli/cli.mjs dev apple-catcher --port 4100   # 本地试玩
node packages/game-cli/cli.mjs build apple-catcher
node packages/game-cli/cli.mjs package apple-catcher
GAME_STATION_TOKEN=<令牌> node packages/game-cli/cli.mjs publish apple-catcher --publish
```
