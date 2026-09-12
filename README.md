# 🎮 游戏发布站 (Game Station)

一个**本地游戏发布平台**:让 DeepSeek Harness 或其他本地 Agent(Claude Code / Codex / OpenCode 等)
把做好的 HTML 游戏发布上来,立即获得公开主页、试玩页和试玩统计。

**平台不生成任何游戏代码** —— Agent 自己写游戏,平台只负责:接收发布 → 托管文件 → 公开展示 → 统计试玩。

## 快速开始

```bash
cd game-station
npm install        # 安装依赖(需网络)
npm start          # 启动服务
```

打开:
- 公开主页: http://127.0.0.1:3210/
- 管理后台: http://127.0.0.1:3210/admin (账号密码打印在启动日志,或看 `config.json`)

## Agent 发布游戏(核心工作流)

Agent 写好游戏后,把本地目录发布上来即可:

```bash
GAME_STATION_TOKEN=<config.json 里的 adminToken> \
  node scripts/publish.mjs /path/to/game-dir --title "游戏名" --publish
```

等价于三个 HTTP 步骤(也支持纯 curl 调用,详见 [AGENTS.md](AGENTS.md)):

1. `POST /api/games` 创建游戏(元数据 + slug)
2. `PUT /api/games/:slug/files/*path` 逐个上传文件(原始字节)
3. `PATCH /api/games/:slug {"playable":true}` 公开试玩

完成后玩家即可访问 `https://你的域名/play/<slug>` 试玩,每次打开自动计数。

> 给 Agent 的完整发布说明(接口表、规范、FAQ)写在 **`AGENTS.md`**,任何 agent 进入本仓库都会自动读到。

## 目录结构

```
game-station/
├── server.js           # 主服务(Express + SQLite):公开页面 + 发布 API + 试玩统计
├── config.json         # 配置(端口、公网开关、管理员账号/令牌)
├── AGENTS.md           # ★ 给 Agent 的发布说明(接口 + 规范 + FAQ)
├── lib/
│   ├── db.js           # 数据库 schema(games / stats)
│   └── config.js       # 配置读写
├── scripts/
│   └── publish.mjs     # ★ Agent 发布器:上传本地目录到平台(纯 Node,无依赖)
├── games/              # 游戏文件,每个游戏一个目录 <slug>/index.html
├── public/             # 前台页面(主页 / 试玩页 / 后台)
└── data/station.db     # SQLite 数据(自动创建)
```

## 配置 (config.json)

| 配置项 | 说明 |
| --- | --- |
| `port` | 端口,默认 3210 |
| `publicHost` | `false`=仅本机;`true`=监听 0.0.0.0,配合内网穿透/云服务器可对外 |
| `adminUser` / `adminPass` | 后台登录账号密码(密码为空时启动自动生成随机密码) |
| `adminToken` | 管理/发布 API 令牌(Agent 发布时用 `x-admin-token` 头携带) |

## 管理后台

- 游戏列表:查看/编辑元数据、公开/下架、删除、近 14 天试玩曲线
- 手动发布:填写元数据创建游戏 → 上传 `index.html`(文本粘贴)或让 Agent 用脚本上传整个目录
- 设置:查看/复制/重新生成管理员令牌、修改密码、Agent 发布说明

## 部署到公网

**当前正式地址:https://game.bosto.tech** (Cloudflare 命名隧道 + 自有域名;旧地址 game.bosto.chat 仍可用)

需要保持运行的两个进程:

```bash
node server.js                    # 发布站本体
cloudflared --config /Users/yes/.cloudflared/config.yml tunnel run  # launchd 托管
```

备用方式:Cloudflare 快速隧道 `cloudflared tunnel --url http://127.0.0.1:3210`,
或部署到 VPS 用 Nginx 反代 3210 端口。

> 对外公开后,所有管理/发布 API 都由 `adminToken` 保护;公开玩家只能看到主页和公开试玩。
> Agent 发布时请通过环境变量 `GAME_STATION_TOKEN` 传令牌,避免写进对话/日志。

## 安全性说明

- 公开页面(主页/试玩/游戏文件/公开 API/试玩计数):任何人可访问
- 管理后台 `/admin` 与所有管理 API(含发布接口):需登录(用户名+密码)或携带令牌
- 未公开游戏(`playable=0`)的文件无法被玩家访问,仅管理员可预览(`?admin=1&token=...`)
- 文件上传有路径越界防护,只能写入 `games/<slug>/` 内

## 从旧版(v0.1 流水线版)升级说明

旧版的「创意→设计→开发→内测→发布」流水线、想法池、AI 生成/迭代、冒烟测试、
微信移植、模型注册表等逻辑已全部移除。启动时自动迁移数据库:
保留 `games` / `stats` 数据,删除废弃表(`ideas` / `decisions` / `wechat_projects` / `settings`),
`config.json` 自动清理旧字段(models / ideaSchedule 等)。

## 常用命令

```bash
npm start                # 启动
npm run dev              # 开发模式(node --watch 自动重启)
npm run publish -- <目录> --title "游戏名" --publish   # Agent 发布
```
