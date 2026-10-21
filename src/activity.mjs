import fs from 'node:fs';
import path from 'node:path';

export function chatKey(thread) { return JSON.stringify([thread.hostId, thread.id]); }

export function conversationTurns(state) {
  const turns = new Map();
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    if (typeof value.turnId === 'string' && typeof value.status === 'string' && Array.isArray(value.items)) {
      turns.set(value.turnId, value); return;
    }
    for (const child of Object.values(value)) visit(child);
  }
  visit(state.turns); visit(state.turnHistory);
  return [...turns.values()].sort((a, b) => (a.turnStartedAtMs ?? 0) - (b.turnStartedAtMs ?? 0));
}

export function latestTurn(state) { return conversationTurns(state).at(-1); }

export function turnResult(turn) {
  const final = turn.items.filter(i => i.type === 'agentMessage' && i.phase === 'final_answer' && typeof i.text === 'string').at(-1);
  return { summary: final?.text.trim().slice(0, 1800) ?? '', error: typeof turn.error === 'string' ? turn.error.slice(0, 800) : turn.error?.message?.slice(0, 800) ?? '' };
}

// Only routing IDs, unfinished turn IDs, and undelivered result excerpts are persisted.
export class BridgeStore {
  constructor(file) {
    this.file = file; this.startedAt = Date.now(); this.initialized = new Set();
    this.data = { nextChat: 1, selected: null, chats: [], active: [], delivered: [], outbox: [] };
    if (file) {
      try { this.data = JSON.parse(fs.readFileSync(file, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (!Number.isSafeInteger(this.data.nextChat) || this.data.nextChat < 1 || !['chats', 'active', 'delivered', 'outbox'].every(k => Array.isArray(this.data[k]))) throw Error('聊天与通知记录无效');
  }
  save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.data), { mode: 0o600 });
    fs.renameSync(this.file + '.tmp', this.file);
  }
  chat(thread) {
    const key = chatKey(thread);
    let chat = this.data.chats.find(c => c.key === key);
    if (!chat) {
      chat = { key, code: String(this.data.nextChat++), hostId: thread.hostId, id: thread.id };
      this.data.chats.push(chat); this.save();
    }
    return chat;
  }
  select(code) { this.data.selected = code; this.save(); }
  observe(thread) {
    const chat = this.chat(thread), initialized = this.initialized.has(chat.key);
    let changed = false;
    for (const turn of conversationTurns(thread.state)) {
      const key = JSON.stringify([thread.hostId, thread.id, turn.turnId]);
      const tracked = this.data.active.includes(key);
      if (turn.status === 'inProgress') {
        if (!tracked) { this.data.active.push(key); changed = true; }
        continue;
      }
      if (!['completed', 'failed', 'interrupted', 'cancelled'].includes(turn.status)) continue;
      if (tracked) { this.data.active.splice(this.data.active.indexOf(key), 1); changed = true; }
      if (this.data.delivered.includes(key)) continue;
      const queued = this.data.outbox.find(n => n.key === key);
      const result = turnResult(turn);
      if (queued) {
        if (queued.summary !== result.summary || queued.error !== result.error) { Object.assign(queued, result); changed = true; }
      } else if (tracked || initialized && turn.turnStartedAtMs >= this.startedAt) {
        this.data.outbox.push({ key, chatCode: chat.code, title: thread.state.title || thread.id, status: turn.status, ...result }); changed = true;
      }
    }
    this.initialized.add(chat.key);
    if (changed) this.save();
    return chat;
  }
  delivered(key) {
    this.data.outbox = this.data.outbox.filter(n => n.key !== key);
    this.data.delivered.push(key); this.data.delivered = this.data.delivered.slice(-5000); this.save();
  }
}

export function renderCompletion(notification) {
  const label = { completed: '本轮完成', failed: '本轮失败', interrupted: '本轮中断', cancelled: '本轮取消' }[notification.status];
  return [`Codex ${label}【聊天${notification.chatCode}】`, notification.title,
    notification.error ? `错误：${notification.error}` : '',
    notification.summary ? `最终回复摘要：\n${notification.summary}` : '桌面未提供最终回复，请到对应聊天查看。',
    `继续这个聊天：继续${notification.chatCode} 你的要求`].filter(Boolean).join('\n');
}
