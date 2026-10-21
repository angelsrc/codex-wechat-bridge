import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

export const VERSIONS = {
  'thread-owner-discovery': 1,
  'thread-stream-following-changed': 1,
  'thread-stream-state-changed': 11,
  'thread-follower-command-approval-decision': 1,
  'thread-follower-file-approval-decision': 1,
  'thread-follower-permissions-request-approval-response': 1,
  'thread-follower-submit-user-input': 1,
  'thread-follower-steer-turn': 1,
  'thread-follower-start-turn': 2,
  'thread-follower-submit-mcp-server-elicitation-response': 1,
};

export function encodeFrame(message) {
  const body = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

export class FrameReader {
  constructor(onMessage, maxBytes = 268435456) { this.onMessage = onMessage; this.maxBytes = maxBytes; this.buffer = Buffer.alloc(0); }
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const size = this.buffer.readUInt32LE(0);
      if (!size || size > this.maxBytes) throw Error('IPC frame length is invalid');
      if (this.buffer.length < size + 4) return;
      const message = JSON.parse(this.buffer.subarray(4, size + 4).toString('utf8'));
      this.buffer = this.buffer.subarray(size + 4);
      this.onMessage(message);
    }
  }
}

// Connects as a follower. It never starts an app-server or takes ownership of a chat.
export class DesktopIpc extends EventEmitter {
  constructor(pipe = String.raw`\\.\pipe\codex-ipc`) { super(); this.pipe = pipe; this.pending = new Map(); this.clientId = 'initializing-client'; this.closed = false; }
  async connect() {
    if (this.socket) throw Error('IPC is already connected');
    const socket = this.socket = net.connect(this.pipe);
    const reader = new FrameReader(message => this.receive(message));
    socket.on('data', chunk => { try { reader.push(chunk); } catch (error) { this.emit('warning', error); socket.destroy(); } });
    socket.on('error', error => this.emit('warning', error));
    socket.on('close', () => {
      this.socket = null; this.clientId = 'initializing-client';
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(Error('Codex IPC disconnected')); }
      this.pending.clear(); this.emit('disconnected');
    });
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    const response = await this.request('initialize', { clientType: 'codex-wechat-bridge' });
    this.clientId = response.result.clientId;
    this.emit('connected', this.clientId);
  }
  write(message) {
    if (!this.socket?.writable) throw Error('Codex IPC is not connected');
    this.socket.write(encodeFrame(message));
  }
  request(method, params, { targetClientId, hostId, timeoutMs = 5000 } = {}) {
    const requestId = randomUUID();
    let version = VERSIONS[method] ?? 0;
    if (hostId && method.startsWith('thread-follower-')) version++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(Error(`${method}: timeout`)); }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      try { this.write({ type: 'request', requestId, sourceClientId: this.clientId, version, method, params, targetClientId, hostId, timeoutMs }); }
      catch (error) { clearTimeout(timer); this.pending.delete(requestId); reject(error); }
    });
  }
  broadcast(method, params, targetClientIds) {
    this.write({ type: 'broadcast', method, params, targetClientIds, sourceClientId: this.clientId, version: VERSIONS[method] ?? 0 });
  }
  receive(message) {
    if (message.type === 'client-discovery-request') {
      this.write({ type: 'client-discovery-response', requestId: message.requestId, response: { canHandle: false } });
    } else if (message.type === 'response') {
      const pending = this.pending.get(message.requestId);
      if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(message.requestId);
      if (message.resultType === 'error') pending.reject(Error(message.error)); else pending.resolve(message);
    } else if (message.type === 'broadcast') this.emit('broadcast', message);
  }
  close() { this.closed = true; this.socket?.destroy(); }
}
