# AGENTS.md — 给 Agent 的发布说明

本文件面向**任何本地 Agent**(DeepSeek Harness、Claude Code、Codex、OpenCode 等)。
game-station 是一个**游戏发布平台**:Agent 负责写游戏代码,平台负责托管、展示和统计。
平台**不生成代码** —— 所有游戏内容都由 Agent 自己写好再发布上来。

## 快速开始(单文件游戏)

1. 写一个**单文件 HTML 游戏**(内联 CSS/JS,无外链依赖最稳),例如:

   ```html
   <!-- /tmp/hello-game/index.html -->
   <!DOCTYPE html><html><head><meta charset="utf-8"><title>Hello</title></head>
   <body><h1>Hello Game</h1><button onclick="alert('hi')">点我</button></body></html>
   ```

2. 用发布脚本上传(推荐):

   ```bash
   GAME_STATION_TOKEN=<令牌> node game-station/scripts/publish.mjs /tmp/hello-game \
     --title "Hello 游戏" --genre "休闲" --source dsh --publish
   ```

   令牌在 `game-station/config.json` 的 `adminToken` 字段(也可以直接读文件拿到,或要求管理员提供环境变量 `GAME_STATION_TOKEN`)。

3. 验证:访问 `http://127.0.0.1:3210/play/hello-game`(公开试玩)或
   `http://127.0.0.1:3210/g/hello-game/index.html`(游戏本体)。

## HTTP API 参考

基础地址:`http://127.0.0.1:3210`(可用环境变量 `GAME_STATION_URL` 覆盖)。
鉴权:管理类接口都要求请求头 `x-admin-token: <令牌>`(或 URL 参数 `?token=`)。公开接口无需鉴权。

| 方法 | 路径 | 用途 | 鉴权 |
| --- | --- | --- | --- |
| POST | `/api/games` | 创建游戏(元数据) | ✅ |
| PATCH | `/api/games/:slug` | 修改元数据 / 公开开关(`playable`) | ✅ |
| DELETE | `/api/games/:slug` | 删除游戏及其全部文件 | ✅ |
| GET | `/api/games` | 全部游戏(管理视角) | ✅ |
| GET | `/api/games?public=1` | 公开可玩游戏列表 | ❌ |
| GET | `/api/games/:slug` | 详情 + 文件列表 + 近 14 天试玩 | ✅ |
| PUT | `/api/games/:slug/files/*path` | **上传文件(原始字节);`?stage=1` 写入暂存目录** | ✅ |
| DELETE | `/api/games/:slug/files/*path` | 删除文件 | ✅ |
| GET | `/api/games/:slug/files` | 文件列表 | ✅ |
| POST | `/api/games/:slug/activate` | **原子激活暂存内容为新版本(旧版自动快照)** | ✅ |
| POST | `/api/games/:slug/rollback` | **回滚到某个 release 快照** | ✅ |
| POST | `/api/games/:slug/releases` | **把当前线上内容固化为 release 快照** | ✅ |
| GET | `/api/games/:slug/releases` | release 列表(含交付物/快照状态) | ✅ |
| POST | `/api/games/:slug/preview-session` | **创建暂存草稿预览会话(短时 /preview/<token>)** | ✅ |
| POST | `/api/games/:slug/releases/:id/preview-session` | 创建历史版本预览会话 | ✅ |
| GET | `/api/games/:slug/releases/:id/artifacts/:file` | 下载交付物(web.zip/source.zip/校验报告等) | ✅ |
| GET | `/preview/<token>/*` | 预览静态资源(短时有效,无需令牌) | 会话 |
| POST | `/api/games/:slug/play` | 试玩计数 | ❌ |

### 原子发布与回滚(推荐)

大改或发布多文件版本时,先用 `--stage` 上传到私密暂存目录(**期间线上旧版完全不受影响**),
再 `--activate` 一次性切换。上传中断只影响暂存,线上始终可玩;激活后旧版自动保留为 release,可随时回滚:

```bash
TOK=<令牌>

# 1) 暂存新版本(不动线上)
GAME_STATION_TOKEN=$TOK node game-station/scripts/publish.mjs ./games/my-game --title "我的游戏" --stage

# 2) 激活为线上新版本(旧版自动快照)
GAME_STATION_TOKEN=$TOK node game-station/scripts/publish.mjs --slug my-game --activate v2 --publish

# 3) 需要时回滚到某个 releaseId
curl -X POST $T/api/games/my-game/rollback -H "x-admin-token: $TOK" -H "Content-Type: application/json" \
  -d '{"releaseId": 1}'
```

发布前可先 `POST /api/games/:slug/releases` 给"即将上线"的当前版本打点。

### 备份

`node scripts/backup.mjs` 用 SQLite 一致性备份 API 生成 `game-station-backups/<时间戳>/`
(数据库 + 游戏文件 + 配置),不直接复制正在写入的 db。

### 统一命令 game-cli(P1)

每款游戏在 `projects/<slug>/` 下有 `game.json` 契约(JSON Schema 校验)。统一命令:

```bash
npm run game -- new <slug> --template <html-canvas|phaser>   # 脚手架
npm run game -- check <slug> [--json]                        # 校验契约+入口+store 素材
npm run game -- build <slug>                                  # 构建到 artifacts/<slug>/<version>/web
npm run game -- package <slug> --targets web,source           # 产出 web.zip / source.zip
npm run game -- publish <slug> [--stage] [--activate v] [--publish]  # 构建并发布到平台
npm run game -- dev <slug> --port 4000                        # 本地静态服务试玩
npm run game -- list
```

发布走构建产物(只含运行时文件),配合平台 `--stage/--activate` 原子发布。

### 发布流程(纯 curl,等价于发布脚本)

```bash
T=http://127.0.0.1:3210; TOK=<令牌>

# 1. 创建游戏(slug 只允许小写字母/数字/连字符)
curl -X POST $T/api/games -H "x-admin-token: $TOK" -H "Content-Type: application/json" \
  -d '{"slug":"my-game","title":"我的游戏","description":"玩法简介","genre":"休闲","source":"dsh"}'

# 2. 上传文件(请求体必须是原始字节;Content-Type 任意非 application/json)
curl -X PUT --data-binary @index.html "$T/api/games/my-game/files/index.html" -H "x-admin-token: $TOK"
curl -X PUT --data-binary @assets/bg.png  "$T/api/games/my-game/files/assets/bg.png"  -H "x-admin-token: $TOK"

# 3. 公开试玩(playable=1 之后玩家才能访问)
curl -X PATCH $T/api/games/my-game -H "x-admin-token: $TOK" -H "Content-Type: application/json" \
  -d '{"playable":true}'

# 4. 验证
curl -s "$T/api/games?public=1" | python3 -m json.tool
```

> ⚠️ 上传时**不要**带 `Content-Type: application/json`(会被当成 JSON 解析而拿不到字节);
> 用 `application/octet-stream` 或 `text/html` 等即可。发布脚本已处理这些细节,优先用它。

## 发布规范(强烈建议)

- **入口文件必须是 `index.html`**(放在游戏目录根),可引用同目录或子目录的相对资源。
- 优先**单文件**(内联 CSS/JS),无外链 CDN/字体/图片,本地就能完整运行。
- 支持**鼠标 + 触屏**(pointer 事件)、移动端 viewport 适配,这样玩家在手机上也能玩。
- 需要音效用 WebAudio 合成,不要依赖外部音频文件。
- 资源较多时放到子目录(如 `assets/`),一并上传。
- 发布前请**自己先验证**再公开:如本地 `python3 -m http.server` 打开跑一遍,
  检查无 JS 报错、开始/进行/结束流程完整。平台不校验代码质量,只负责托管。

## 常见问题

- **404 / 403**:游戏还没创建,或 `playable` 还是 0。先 POST 创建,再 PATCH `{"playable":true}`。
- **上传 400「请求体为空」**:带了 `Content-Type: application/json` 导致字节被吞,改用 octet-stream。
- **想大改一个已发布游戏**:推荐用上面的 `--stage` + `--activate` 原子发布(旧版自动快照,可回滚);
  直接覆盖上传 `index.html` 仍可用,但无版本快照。
- **想换 slug**:slug 创建后不可改,重新创建一个游戏并上传即可。
- **统计**:每次打开试玩页计一次试玩;后台可看 14 天曲线。

## 平台目录约定

```
game-station/
├── server.js           # 服务(Express + SQLite),只做发布/托管/统计
├── scripts/            # publish.mjs 发布器 / backup.mjs 备份 / ci-smoke.sh 冒烟
├── packages/game-cli/  # 统一命令 game(new/check/build/package/publish/dev/list)+ 模板
├── projects/<slug>/    # 游戏开发源(game.json 契约 + index.html + store 素材)
├── games/<slug>/       # 平台发布的线上内容(由 API/脚本写入,玩家访问)
├── artifacts/<slug>/<version>/  # 构建产物(web.zip/source.zip/校验报告,不入库)
├── public/             # 公开主页 / 试玩页 / 管理后台
└── config.json         # 端口 / 管理员账号 / 令牌
```
