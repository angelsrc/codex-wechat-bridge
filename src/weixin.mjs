import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export const API_BASE = 'https://ilinkai.weixin.qq.com';
const CHANNEL_VERSION = '2.4.8';
const BASE_INFO = { channel_version: CHANNEL_VERSION, bot_agent: 'CodexWeChatBridge/0.2.0' };

export function parseApiJson(raw) {
  // WeChat message IDs are uint64; keep their exact decimal representation for deduplication.
  let output = '', index = 0;
  while (index < raw.length) {
    if (raw[index] !== '"') { output += raw[index++]; continue; }
    const start = index++; let escaped = false;
    while (index < raw.length) { const c = raw[index++]; if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') break; }
    const token = raw.slice(start, index); output += token;
    let cursor = index; while (/\s/.test(raw[cursor] ?? '')) cursor++;
    if (raw[cursor] !== ':' || !['message_id', 'msg_id', 'svr_id'].includes(JSON.parse(token))) continue;
    cursor++; while (/\s/.test(raw[cursor] ?? '')) cursor++;
    const number = raw.slice(cursor).match(/^-?\d+(?=[,}\]\s])/);
    if (!number) continue;
    output += raw.slice(index, cursor) + JSON.stringify(number[0]); index = cursor + number[0].length;
  }
  return JSON.parse(output);
}

export function validateBase(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !(url.hostname === 'weixin.qq.com' || url.hostname.endsWith('.weixin.qq.com')) || url.username || url.password || url.port) throw Error('微信返回的服务地址不受支持');
  return url.origin;
}

export class WeixinApi {
  constructor({ fetchFn = fetch } = {}) { this.fetchFn = fetchFn; }
  async request(endpoint, { base = API_BASE, token, body, timeout = 15000, signal } = {}) {
    const headers = { 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': String((2 << 16) | (4 << 8) | 8) };
    if (body !== undefined) Object.assign(headers, { 'Content-Type': 'application/json', AuthorizationType: 'ilink_bot_token', 'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64') });
    if (token) headers.Authorization = `Bearer ${token}`;
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeout);
    const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) controller.abort();
    try {
      const response = await this.fetchFn(new URL(endpoint, validateBase(base) + '/'), { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal, redirect: 'error' });
      if (!response.ok) throw Error(`微信 HTTP ${response.status}`);
      const data = parseApiJson(await response.text());
      for (const field of ['ret', 'errcode']) if (data[field] && data[field] !== 0) { const error = Error(`微信接口错误 ${data[field]}`); error.code = data[field]; throw error; }
      return data;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  qr() { return this.request('ilink/bot/get_bot_qrcode?bot_type=3', { body: { local_token_list: [] } }); }
  qrStatus(qrcode, base = API_BASE, code) { return this.request(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}${code ? `&verify_code=${encodeURIComponent(code)}` : ''}`, { base, timeout: 35000 }); }
}

export class WeixinMessenger {
  constructor({ api = new WeixinApi(), account, state = {}, saveState = async () => {}, log = console.log }) {
    this.api = api; this.account = account; this.state = state; this.saveState = saveState; this.log = log; this.stopped = false; this.seen = new Set(state.seen ?? []);
  }
  get ready() { return Boolean(this.account && this.state.contextToken); }
  async send(text) {
    if (!this.ready) throw Error('请先在微信 ClawBot 中发送“连接”，建立消息上下文');
    await this.api.request('ilink/bot/sendmessage', { base: this.account.baseUrl, token: this.account.token, body: { msg: { from_user_id: '', to_user_id: this.account.userId, client_id: `codex_${randomUUID()}`, message_type: 2, message_state: 2, context_token: this.state.contextToken, item_list: [{ type: 1, text_item: { text } }] }, base_info: BASE_INFO } });
  }
  async consume(message, onText, onReady) {
    if (message.message_type !== 1 || message.from_user_id !== this.account.userId) return;
    // Hash the complete message instead of converting uint64 IDs to JS numbers for deduplication.
    const key = createHash('sha256').update(JSON.stringify(message)).digest('hex');
    if (this.seen.has(key)) return;
    this.seen.add(key); if (this.seen.size > 1000) this.seen.delete(this.seen.values().next().value);
    const wasReady = this.ready;
    if (message.context_token) this.state.contextToken = message.context_token;
    this.state.seen = [...this.seen]; await this.saveState(this.state);
    const text = (message.item_list ?? []).filter(item => item.type === 1 && typeof item.text_item?.text === 'string').map(item => item.text_item.text).join('\n');
    if (!text) return;
    if (text.trim() === '连接') { await this.send('Codex 微信桥接已连接。桌面端照常使用；审批、提问和完成/失败结果会同步到这里。发送“状态”查看聊天，“待处理”查看审批和问题，“帮助”查看用法。'); onReady?.(); }
    else { if (!wasReady && this.ready) onReady?.(); await onText(text); }
  }
  async poll(onText, onReady) {
    this.controller = new AbortController(); let failures = 0;
    while (!this.stopped) {
      try {
        const data = await this.api.request('ilink/bot/getupdates', { base: this.account.baseUrl, token: this.account.token, body: { get_updates_buf: this.state.cursor ?? '', base_info: BASE_INFO }, timeout: 40000, signal: this.controller.signal });
        for (const message of data.msgs ?? []) {
          try { await this.consume(message, onText, onReady); }
          catch (error) { this.log(`处理微信消息失败：${error.message}`); }
        }
        if (data.get_updates_buf) { this.state.cursor = data.get_updates_buf; await this.saveState(this.state); }
        failures = 0;
        if (!(data.msgs?.length)) await delay(1000, undefined, { signal: this.controller.signal });
      } catch (error) {
        if (this.stopped) break;
        if (error.name === 'AbortError') continue;
        this.log(`微信连接异常：${error.message}；桌面端继续正常工作`);
        await delay(error.code === -14 ? 60000 : Math.min(30000, 1000 * 2 ** Math.min(++failures, 5)), undefined, { signal: this.controller.signal }).catch(() => {});
      }
    }
  }
  stop() { this.stopped = true; this.controller?.abort(); }
}
