// 配置加载:config.json 不存在时生成默认配置
// 仅保留平台运行所需配置:端口 / 公网开关 / 管理员账号。模型与想法相关配置已移除。
'use strict';
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

const DEFAULT_CONFIG = {
  host: '127.0.0.1',
  port: 3210,
  // 公开主页是否允许被局域网/公网访问(true 时监听 0.0.0.0)
  publicHost: false,
  // 后台登录账号(用户名+密码)。密码为空时启动自动生成随机密码并打印在日志
  adminUser: 'admin',
  adminPass: '',
  // 管理/发布 API 的会话令牌:登录成功后自动获得,Agent 发布时也用它鉴权
  adminToken: '',
};

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf8');
    return structuredClone(DEFAULT_CONFIG);
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    console.error('[config] 解析失败,使用默认配置:', e.message);
    raw = {};
  }
  const cfg = { ...DEFAULT_CONFIG };
  for (const k of Object.keys(DEFAULT_CONFIG)) {
    if (raw[k] !== undefined) cfg[k] = raw[k];
  }
  // 清理旧版本遗留的字段(models / ideaSchedule / deepseek 等),写入干净配置
  const dirty = Object.keys(raw).some((k) => !(k in DEFAULT_CONFIG));
  if (dirty) saveConfig(cfg);
  return cfg;
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}

module.exports = { loadConfig, saveConfig, CONFIG_PATH, DEFAULT_CONFIG };
