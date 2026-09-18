// 浏览器级玩法测试(CDP,零依赖):启动无头 Chrome → 加载游戏 → 收集 JS 错误 →
// 点击开始/重开 → 模拟指针操作 → 再次收集错误 → 截图取证 → 输出报告。
// 用于满足计划 P1「开始/核心操作/结束/重开」验证与验证深度要求。
'use strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let s = '';
      res.on('data', (d) => (s += d));
      res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function launch() {
  if (!fs.existsSync(CHROME)) throw new Error(`未找到 Chrome: ${CHROME}(可设置 CHROME_BIN)`);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-bt-'));
  const proc = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--mute-audio',
    `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank',
  ], { stdio: 'ignore' });
  // 读取 DevToolsActivePort(端口 + 浏览器 ws 路径)
  let port = null, wsPath = null;
  for (let i = 0; i < 50 && !port; i++) {
    const f = path.join(profile, 'DevToolsActivePort');
    if (fs.existsSync(f)) {
      const [p, ws] = fs.readFileSync(f, 'utf8').split('\n').map((s) => s.trim());
      port = p; wsPath = ws;
    } else await sleep(200);
  }
  if (!port) { proc.kill('SIGKILL'); throw new Error('Chrome 未就绪(DevToolsActivePort 超时)'); }
  // 找到 page 目标
  let target = null;
  for (let i = 0; i < 30 && !target; i++) {
    try {
      const list = await httpGetJson(`http://127.0.0.1:${port}/json/list`);
      target = (list || []).find((t) => t.type === 'page');
    } catch (e) {}
    if (!target) await sleep(300);
  }
  if (!target) { proc.kill('SIGKILL'); throw new Error('未找到 page 目标'); }
  return { proc, profile, pageWs: target.webSocketDebuggerUrl };
}

export async function browserTest({ url, actions, screenshotPath, timeoutMs = 30000 }) {
  const { proc, profile, pageWs } = await launch();
  const errors = [];
  const events = [];
  try {
    const ws = new WebSocket(pageWs);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let id = 0;
    const pending = new Map();
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
      if (m.method === 'Runtime.exceptionThrown') errors.push(`exception: ${m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || ''}`.slice(0, 300));
      else if (m.method === 'Log.entryAdded' && m.params.entry?.level === 'error' && !/favicon/i.test(m.params.entry.url || m.params.entry.text || '')) errors.push(`log: ${m.params.entry.text} ${m.params.entry.url ? '(' + m.params.entry.url + ')' : ''}`.slice(0, 300));
      else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(`console: ${(m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ')}`.slice(0, 300));
      else if (m.method === 'Page.loadEventFired') events.push('load');
      else if (m.method === 'Runtime.evaluate') events.push('eval');
    };
    const send = (method, params = {}) => new Promise((res, rej) => {
      const mid = ++id;
      pending.set(mid, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result)));
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
    const evaluate = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      return r.result?.value;
    };

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Log.enable');
    await send('Page.navigate', { url });
    // 等待加载完成(load 事件或超时)
    for (let i = 0; i < Math.ceil(timeoutMs / 250) && !events.includes('load'); i++) await sleep(250);
    await sleep(1000); // 给首帧渲染时间

    const startedBy = await (actions?.start ? evaluate(actions.start) : Promise.resolve(null));
    if (actions?.waitAfterStart) await sleep(actions.waitAfterStart);
    let interactResult = null;
    if (actions?.tapPoints) {
      for (const pt of actions.tapPoints) {
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt[0], y: pt[1], button: 'left', clickCount: 1 });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt[0], y: pt[1], button: 'left', clickCount: 1 });
        await sleep(120);
      }
      interactResult = true;
    }
    if (actions?.evaluate) interactResult = await evaluate(actions.evaluate);
    await sleep(800);

    // 截图取证
    let screenshot = null;
    if (screenshotPath) {
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
      fs.writeFileSync(screenshotPath, Buffer.from(shot.data, 'base64'));
      screenshot = screenshotPath;
    }
    const finalState = actions?.finalState ? await evaluate(actions.finalState) : null;
    ws.close();
    return { ok: errors.length === 0, consoleErrors: [...new Set(errors)], startedBy, interactResult, finalState, screenshot, profile };
  } finally {
    proc.kill('SIGKILL');
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  }
}

export { CHROME };
