import { EventEmitter } from 'node:events';
import { DesktopIpc, VERSIONS } from './ipc.mjs';
import { projectHistory, historyPatchRelevant, pendingRequests } from './questions.mjs';
import { randomUUID } from 'node:crypto';
import { latestTurn } from './activity.mjs';

const FIELDS = new Set(['requests', 'title', 'cwd', 'id', 'turns', 'turnHistory', 'threadRuntimeStatus']);
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function projectState(state) {
  if (!state || !Array.isArray(state.requests)) throw Error('Unsupported Codex conversation snapshot');
  return { id: state.id, title: state.title ?? '', cwd: state.cwd ?? '', requests: structuredClone(state.requests), turns: projectHistory(state.turns ?? []), turnHistory: projectHistory(state.turnHistory ?? null), threadRuntimeStatus: structuredClone(state.threadRuntimeStatus ?? null) };
}

// Retain only fields used by requests, task status, and final result notifications.
export function applyRequestPatches(state, patches) {
  for (const patch of patches) {
    if (!Array.isArray(patch.path) || patch.path.some(key => UNSAFE_KEYS.has(String(key)))) throw Error('Invalid Codex patch path');
    const path = patch.path;
    if (!path.length) { state = projectState(patch.value); continue; }
    if (!FIELDS.has(path[0])) continue;
    const history = path[0] === 'turns' || path[0] === 'turnHistory';
    if (history && !historyPatchRelevant(path)) continue;
    const value = history && !path.includes('questions') ? projectHistory(patch.value, path.at(-1)) : patch.value;
    let parent = state;
    for (const key of path.slice(0, -1)) { if (parent[key] == null) throw Error('Codex patch path is missing'); parent = parent[key]; }
    const key = path.at(-1);
    if (history && key === 'text' && (parent.type !== 'agentMessage' || parent.phase !== 'final_answer')) continue;
    if (patch.op === 'remove') { if (Array.isArray(parent)) parent.splice(Number(key), 1); else delete parent[key]; }
    else if (patch.op === 'add') { if (Array.isArray(parent)) parent.splice(Number(key), 0, structuredClone(value)); else parent[key] = structuredClone(value); }
    else if (patch.op === 'replace') parent[key] = structuredClone(value);
    else throw Error(`Unsupported Codex patch operation: ${patch.op}`);
  }
  if (!Array.isArray(state.requests)) throw Error('Codex request state is invalid');
  return state;
}

export class Desktop extends EventEmitter {
  constructor({ ipc = new DesktopIpc(), catalog = async () => [] } = {}) {
    super(); this.ipc = ipc; this.catalog = catalog; this.threads = new Map(); this.discovering = new Set(); this.stopped = false; this.retry = null; this.scanRunning = false;
    ipc.on('warning', error => this.emit('warning', error));
    ipc.on('broadcast', message => this.onBroadcast(message));
    ipc.on('disconnected', () => {
      for (const thread of this.threads.values()) { thread.fresh = false; this.emit('unavailable', thread); }
      this.emit('status', 'disconnected');
      if (!this.stopped) this.retry = setTimeout(() => this.startConnection(), 3000);
    });
  }
  async start() { this.stopped = false; await this.startConnection(); this.timer = setInterval(() => this.scan(), 10000); }
  async startConnection() {
    try { await this.ipc.connect(); this.emit('status', 'connected'); for (const t of this.threads.values()) t.retryAt = 0; await this.scan(); }
    catch (error) { this.emit('warning', error); if (!this.ipc.socket && !this.stopped && !this.retry) this.retry = setTimeout(() => { this.retry = null; this.startConnection(); }, 3000); }
  }
  async scan() {
    if (this.scanRunning || this.ipc.clientId === 'initializing-client') return;
    this.scanRunning = true;
    try {
      const candidates = await this.catalog();
      let index = 0;
      await Promise.all(Array.from({ length: 4 }, async () => {
        while (index < candidates.length && !this.stopped) {
          const candidate = candidates[index++], key = `${candidate.hostId}:${candidate.id}`, previous = this.threads.get(key);
          if (previous?.fresh || previous?.retryAt > Date.now()) continue;
          await this.follow(candidate.id, candidate.hostId);
        }
      }));
    } catch (error) { this.emit('warning', error); }
    finally { this.scanRunning = false; }
  }
  async follow(id, hostId = 'local') {
    const key = `${hostId}:${id}`;
    if (this.discovering.has(key)) return;
    this.discovering.add(key);
    try {
      const owner = await this.ipc.request('thread-owner-discovery', { hostId, conversationId: id });
      const prior = this.threads.get(key);
      const thread = { ...prior, id, hostId, owner: owner.handledByClientId, fresh: false, retryAt: Date.now() + 30000 };
      this.threads.set(key, thread);
      this.ipc.broadcast('thread-stream-following-changed', { hostId, conversationId: id, following: true }, [thread.owner]);
    } catch (error) {
      this.threads.set(key, { ...this.threads.get(key), id, hostId, fresh: false, retryAt: Date.now() + 30000 });
      if (!/no-client-found|timeout/.test(error.message)) this.emit('warning', error);
    } finally { this.discovering.delete(key); }
  }
  onBroadcast(message) {
    const { method, params, sourceClientId, version } = message;
    if (method === 'client-status-changed' && params.status === 'disconnected') {
      for (const thread of this.threads.values()) if (thread.owner === params.clientId) { thread.fresh = false; thread.retryAt = 0; this.emit('unavailable', thread); }
      return;
    }
    const id = params?.conversationId, hostId = params?.hostId;
    if (!id || !hostId) return;
    const key = `${hostId}:${id}`, thread = this.threads.get(key);
    if (method !== 'thread-stream-state-changed') {
      if (!thread?.fresh && sourceClientId !== this.ipc.clientId) this.follow(id, hostId);
      return;
    }
    if (!thread || sourceClientId !== thread.owner) return;
    if (version !== VERSIONS[method]) { thread.fresh = false; this.emit('unavailable', thread); this.emit('warning', Error(`Codex stream protocol ${version} is unsupported; expected ${VERSIONS[method]}`)); return; }
    try {
      const change = params.change;
      const relevant = change.type === 'snapshot' || change.patches?.some(p => !p.path?.length || FIELDS.has(p.path[0]) && (!['turns', 'turnHistory'].includes(p.path[0]) || historyPatchRelevant(p.path)));
      if (change.type === 'snapshot') thread.state = projectState(change.conversationState);
      else if (change.type === 'patches' && thread.fresh && change.baseRevision === thread.revision) thread.state = applyRequestPatches(thread.state, change.patches);
      else { thread.fresh = false; this.emit('unavailable', thread); this.requestSnapshot(thread); return; }
      thread.revision = change.revision; thread.fresh = true; thread.lastUpdate = Date.now();
      if (relevant) this.emit('state', thread);
    } catch (error) { thread.fresh = false; this.emit('unavailable', thread); this.emit('warning', error); this.requestSnapshot(thread); }
  }
  requestSnapshot(thread) {
    this.ipc.broadcast('thread-stream-following-changed', { hostId: thread.hostId, conversationId: thread.id, following: true }, [thread.owner]);
  }
  async refresh(thread, timeout = 4000) {
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); this.off('state', listener); this.off('unavailable', unavailable); };
      const listener = next => { if (next.id === thread.id && next.hostId === thread.hostId) { cleanup(); resolve(next); } };
      const unavailable = next => { if (next.id === thread.id && next.hostId === thread.hostId) { cleanup(); reject(Error('桌面聊天当前不可用')); } };
      const timer = setTimeout(() => { cleanup(); reject(Error('桌面状态同步超时，请在桌面处理')); }, timeout);
      this.on('state', listener); this.on('unavailable', unavailable);
      try { this.requestSnapshot(thread); } catch (error) { cleanup(); reject(error); }
    });
  }
  async reply(entry, response, validate = () => {}) {
    let thread = this.threads.get(`${entry.hostId}:${entry.threadId}`);
    if (!thread?.fresh) throw Error('桌面连接未就绪，请在桌面处理');
    thread = await this.refresh(thread);
    if (!pendingRequests(thread.state).some(r => String(r.id) === String(entry.request.id) && r.method === entry.request.method)) return { alreadyResolved: true };
    validate();
    const params = { conversationId: entry.threadId, requestId: entry.request.id, ...response.payload };
    if (response.method === 'thread-follower-steer-turn') {
      const text = response.payload.input[0].text, clientUserMessageId = randomUUID();
      delete params.requestId;
      params.clientUserMessageId = clientUserMessageId;
      params.restoreMessage = { id: clientUserMessageId, text, cwd: thread.state.cwd, createdAt: Date.now(), context: { prompt: text, turnTrigger: 'send_user_message_async_question', workspaceRoots: [thread.state.cwd], addedFiles: [], fileAttachments: [], ideContext: null, imageAttachments: [], commentAttachments: [] }, responsesapiClientMetadata: { source: 'codex' } };
    }
    await this.ipc.request(response.method, params, { targetClientId: thread.owner, ...(thread.hostId === 'local' ? {} : { hostId: thread.hostId }) });
    // The desktop owner checks and removes the pending request synchronously.
    // Its acknowledgement can also mean a desktop click won the race, so do not claim a winner.
    return { submitted: true };
  }
  async continueChat(chat, text) {
    let thread = this.threads.get(`${chat.hostId}:${chat.id}`);
    if (!thread?.fresh) throw Error('这个聊天的桌面连接未就绪，请在桌面打开后重试');
    thread = await this.refresh(thread);
    if (pendingRequests(thread.state).length) throw Error('这个聊天还有待处理的审批或问题，请先发送“待处理”并完成回复');
    const turn = latestTurn(thread.state);
    const active = turn?.status === 'inProgress';
    if (!active && thread.state.threadRuntimeStatus?.type === 'active') throw Error('聊天正在切换回合，请稍后重试');
    const id = randomUUID(), input = [{ type: 'text', text, text_elements: [] }];
    const restoreMessage = { id, text, cwd: thread.state.cwd, createdAt: Date.now(), context: { prompt: text, turnTrigger: 'composer', workspaceRoots: [thread.state.cwd], addedFiles: [], fileAttachments: [], ideContext: null, imageAttachments: [], commentAttachments: [] }, responsesapiClientMetadata: { source: 'codex' } };
    const method = active ? 'thread-follower-steer-turn' : 'thread-follower-start-turn';
    const params = active
      ? { conversationId: chat.id, clientUserMessageId: id, input, attachments: [], restoreMessage }
      : { conversationId: chat.id, turnStart: { request: { threadId: chat.id, clientUserMessageId: id, turnTrigger: 'composer', input, responsesapiClientMetadata: { source: 'codex' } }, context: { restoreMessage, attachments: [], commentAttachments: [], inheritThreadSettings: true } } };
    // The owner inherits current model and permissions. Never override them here.
    const response = await this.ipc.request(method, params, { targetClientId: thread.owner, timeoutMs: 30000, ...(chat.hostId === 'local' ? {} : { hostId: chat.hostId }) });
    if (response.result?.result?.error) throw Error(response.result.result.error.message || '桌面未接受这条消息');
    return { active };
  }
  stop() {
    this.stopped = true; clearTimeout(this.retry); clearInterval(this.timer);
    for (const thread of this.threads.values()) if (thread.owner && this.ipc.socket?.writable) this.ipc.broadcast('thread-stream-following-changed', { hostId: thread.hostId, conversationId: thread.id, following: false }, [thread.owner]);
    this.ipc.close();
  }
}
