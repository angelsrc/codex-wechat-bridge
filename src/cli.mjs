import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { Desktop } from './desktop.mjs';
import { Bridge } from './bridge.mjs';
import { createCodeGenerator } from './codes.mjs';
import { BridgeStore } from './activity.mjs';
import { WeixinApi, WeixinMessenger, API_BASE, validateBase } from './weixin.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, 'data');
const run = promisify(execFile);
let config = { codexHome: process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), python: 'python' };
try { config = { ...config, ...JSON.parse(await fs.readFile(path.join(root, 'config.json'), 'utf8')) }; } catch (error) { if (error.code !== 'ENOENT') throw error; }

function log(text) { console.log(`${new Date().toISOString()} ${text}`); }
async function readJson(name, fallback) { try { return JSON.parse(await fs.readFile(path.join(dataDir, name), 'utf8')); } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; } }
async function saveJson(name, value) { await fs.mkdir(dataDir, { recursive: true }); const target = path.join(dataDir, name); await fs.writeFile(target + '.tmp', JSON.stringify(value), { mode: 0o600 }); await fs.rename(target + '.tmp', target); }
async function catalog() {
  const { stdout } = await run(config.python, [path.join(root, 'src', 'catalog.py'), config.codexHome], { windowsHide: true, timeout: 7000, maxBuffer: 1024 * 1024, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  return JSON.parse(stdout);
}

async function login() {
  const { default: QRCode } = await import('qrcode');
  await fs.mkdir(dataDir, { recursive: true });
  const api = new WeixinApi(); const qr = await api.qr();
  if (!qr.qrcode || !qr.qrcode_img_content) throw Error('微信没有返回有效二维码');
  const image = path.join(dataDir, 'wechat-login.png');
  await QRCode.toFile(image, qr.qrcode_img_content, { width: 480, margin: 4, errorCorrectionLevel: 'M' });
  console.log(`WECHAT_QR_IMAGE=${image}`);
  if (!process.argv.includes('--no-terminal-qr')) console.log(await QRCode.toString(qr.qrcode_img_content, { type: 'terminal', small: true }));
  log('请用微信扫码并确认授权；二维码约 5 分钟内有效。');
  const input = createInterface({ input: process.stdin, output: process.stdout }); let code;
  input.on('line', line => { if (/^[A-Za-z0-9]{4,12}$/.test(line.trim())) code = line.trim(); });
  let base = API_BASE, previous;
  try {
    const expires = Date.now() + 300000;
    while (Date.now() < expires) {
      let result;
      try { result = await api.qrStatus(qr.qrcode, base, code); code = undefined; }
      catch (error) { if (error.name === 'AbortError') continue; throw error; }
      if (result.status !== previous) { previous = result.status; log(`微信扫码状态：${result.status}`); }
      if (result.status === 'confirmed') {
        if (!result.bot_token || !result.ilink_user_id) throw Error('扫码成功但缺少账号绑定信息');
        await saveJson('account.json', { token: result.bot_token, userId: result.ilink_user_id, botId: result.ilink_bot_id, baseUrl: validateBase(result.baseurl || API_BASE) });
        await saveJson('weixin-state.json', {});
        log('微信已绑定。启动桥接后，请在微信 ClawBot 中发送“连接”。');
        return;
      }
      if (result.status === 'expired') throw Error('二维码已过期，请重新运行扫码绑定');
      if (result.status === 'verify_code_blocked') throw Error('配对码验证受限，请重新扫码');
      if (result.status === 'need_verifycode') log('需要配对码：请将微信显示的配对码输入本终端并回车。');
      if (result.status === 'scaned_but_redirect' && result.redirect_host) base = validateBase(result.redirect_host.startsWith('https://') ? result.redirect_host : `https://${result.redirect_host}`);
      if (result.status === 'binded_redirect') throw Error('此机器人已绑定其他实例，请按微信页面提示解除旧绑定后重试');
      await delay(1000);
    }
    throw Error('等待扫码超时，请重新运行扫码绑定');
  } finally { input.close(); }
}

async function acquireLock() {
  await fs.mkdir(dataDir, { recursive: true }); const target = path.join(dataDir, 'bridge.lock');
  try { const old = JSON.parse(await fs.readFile(target, 'utf8')); if (Number.isInteger(old.pid)) { try { process.kill(old.pid, 0); throw Error('桥接已在运行，请勿重复启动'); } catch (error) { if (error.code !== 'ESRCH') throw error; } } await fs.unlink(target); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const file = await fs.open(target, 'wx', 0o600); await file.writeFile(JSON.stringify({ pid: process.pid })); await file.close();
  return async () => { await fs.unlink(target).catch(error => { if (error.code !== 'ENOENT') log(`清除锁文件失败：${error.message}`); }); };
}

async function start() {
  const account = await readJson('account.json', null);
  if (!account) throw Error('尚未绑定微信，请先运行 npm run login 或“扫码绑定.cmd”');
  const unlock = await acquireLock();
  const desktop = new Desktop({ catalog });
  const messenger = new WeixinMessenger({ account, state: await readJson('weixin-state.json', {}), saveState: value => saveJson('weixin-state.json', value), log });
  const bridge = new Bridge({ desktop, messenger, log, nextCode: createCodeGenerator(path.join(dataDir, 'code-sequence.json')), store: new BridgeStore(path.join(dataDir, 'bridge-state.json')) });
  const status = { version: '0.2.0', startedAt: new Date().toISOString(), desktop: 'connecting', threads: 0, pending: 0, wechatContextReady: messenger.ready };
  let statusWrite = Promise.resolve();
  const saveStatus = () => { statusWrite = statusWrite.then(() => saveJson('status.json', { ...status, threads: [...desktop.threads.values()].filter(t => t.fresh).length, pending: [...bridge.entries.values()].filter(e => !e.resolved && e.available).length, wechatContextReady: messenger.ready })).catch(error => log(`状态文件更新失败：${error.message}`)); };
  desktop.on('status', text => { status.desktop = text; log(`桌面通信：${text}`); saveStatus(); });
  desktop.on('warning', error => log(`桌面通信提示：${error.message}`));
  desktop.on('state', saveStatus);
  let stopping = false;
  let stopTimer;
  const notificationTimer = setInterval(() => bridge.flushNotifications(), 15000);
  const stop = async () => { if (stopping) return; stopping = true; clearInterval(stopTimer); clearInterval(notificationTimer); messenger.stop(); desktop.stop(); status.desktop = 'stopped'; saveStatus(); await statusWrite; await unlock(); log('桥接已停止；桌面 Codex 继续正常工作。'); };
  stopTimer = setInterval(async () => { try { const request = await readJson('stop-request.json', null); if (request?.pid === process.pid) { await fs.unlink(path.join(dataDir, 'stop-request.json')); await stop(); } } catch (error) { log(`停止请求读取失败：${error.message}`); } }, 1000);
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    log('启动微信桥接。桌面弹窗正常出现，微信独立收发。按 Ctrl+C 停止桥接。');
    await desktop.start();
    await messenger.poll(text => bridge.onText(text), () => { bridge.notifyReady(); saveStatus(); });
  } finally { await stop(); }
}

async function stopService() {
  const lock = await readJson('bridge.lock', null);
  if (!lock?.pid) throw Error('没有发现运行中的桥接服务');
  await saveJson('stop-request.json', { pid: lock.pid });
  log('已通知桥接服务停止；桌面 Codex 保持运行。');
}

async function doctor() {
  const rows = await catalog(); log(`可发现 ${rows.length} 个最近聊天（元数据只读）`);
  const desktop = new Desktop({ catalog: async () => rows.slice(0, 12) });
  desktop.on('warning', error => log(`提示：${error.message}`));
  const states = new Set();
  desktop.on('state', thread => { if (!states.has(thread.id)) { states.add(thread.id); log(`实时订阅成功：${thread.id}；待处理请求 ${thread.state.requests.length}`); } });
  try { await desktop.start(); await delay(5000); if (desktop.ipc.clientId === 'initializing-client') throw Error('未连接到桌面实例，请在当前 Windows 用户下打开 Codex'); log(`诊断完成：已接入当前桌面实例，订阅 ${states.size} 个聊天。未提交审批或回答。`); }
  finally { desktop.stop(); }
}

try {
  switch (process.argv[2]) { case 'login': await login(); break; case 'start': await start(); break; case 'stop': await stopService(); break; case 'doctor': await doctor(); break; default: console.log('用法：node src/cli.mjs login | start | stop | doctor'); }
} catch (error) { console.error(`错误：${error.message}`); process.exitCode = 1; }
