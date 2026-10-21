import { SUPPORTED, requestKey, renderRequest, quickApprovalReply, parseReply, buildResponse, splitMessage } from './requests.mjs';
import { pendingRequests } from './questions.mjs';
import { createCodeGenerator } from './codes.mjs';
import { BridgeStore, latestTurn, renderCompletion } from './activity.mjs';

const HELP = '发送“状态”查看聊天与运行状态；“待处理”查看审批和问题。\n审批：同意101 / 拒绝101；只有一条待审批时可直接发“同意”或“拒绝”。\n回答问题：回答102 你的答案\n选择聊天：切换1；之后直接发送文字。也可用：继续1 你的要求';
const approval = entry => Boolean(quickApprovalReply(entry));
const requestType = entry => ({ 'item/commandExecution/requestApproval': '命令审批', 'item/fileChange/requestApproval': '文件审批', 'item/permissions/requestApproval': '权限审批', 'mcpServer/elicitation/request': 'MCP 确认/表单', 'desktop/asyncQuestion': '问题', 'item/tool/requestUserInput': '问题' }[entry.request.method]);

export class Bridge {
  constructor({ desktop, messenger, log = console.log, nextCode = createCodeGenerator(), store = new BridgeStore() }) {
    this.desktop = desktop; this.messenger = messenger; this.log = log;
    this.nextCode = nextCode;
    this.store = store; this.notifying = new Set(); this.chatBusy = new Set();
    this.entries = new Map(); this.codes = new Map(); this.busy = new Set(); this.queue = Promise.resolve(); this.notificationEpoch = 0;
    desktop.on('state', thread => this.observe(thread));
    desktop.on('unavailable', thread => { for (const entry of this.entries.values()) if (entry.threadId === thread.id && entry.hostId === thread.hostId) entry.available = false; });
  }
  enqueue(task) {
    const epoch = this.notificationEpoch, current = () => epoch === this.notificationEpoch && this.messenger.ready;
    this.queue = this.queue.then(() => task(current)).catch(error => this.log(`微信发送失败：${error.message}`)); return this.queue;
  }
  async send(text, current = () => true) {
    for (const part of splitMessage(text)) { if (!current()) return false; await this.messenger.send(part); }
    return current();
  }
  observe(thread) {
    const chat = this.store.observe(thread);
    const active = new Set();
    for (const request of pendingRequests(thread.state)) {
      if (!SUPPORTED.has(request.method)) continue;
      const key = requestKey(thread.hostId, thread.id, request); active.add(key);
      let entry = this.entries.get(key);
      if (!entry) {
        const code = this.nextCode();
        entry = { key, code, chatCode: chat.code, request: structuredClone(request), threadId: thread.id, hostId: thread.hostId, title: thread.state.title, cwd: thread.state.cwd, available: true, resolved: false, announced: false };
        this.entries.set(key, entry); this.codes.set(code, entry);
        this.log(`发现待处理请求 ${code} (${request.method})`);
      }
      entry.available = true; entry.title = thread.state.title;
      if (entry.announcedEpoch !== this.notificationEpoch && !entry.resolved && !entry.submitted && !entry.announcing && this.messenger.ready) {
        const announcing = Symbol(); entry.announcing = announcing;
        this.enqueue(async current => {
          try {
            const actionable = () => current() && !entry.resolved && entry.available && !entry.submitted;
            if (!await this.send(renderRequest(entry), actionable)) return;
            entry.announced = true; entry.announcedEpoch = this.notificationEpoch;
            const quickReply = quickApprovalReply(entry);
            if (quickReply) await this.send(quickReply, actionable);
          }
          finally { if (entry.announcing === announcing) entry.announcing = false; }
        });
      }
    }
    for (const entry of this.entries.values()) {
      if (entry.hostId !== thread.hostId || entry.threadId !== thread.id || entry.resolved || active.has(entry.key)) continue;
      entry.resolved = true; entry.available = false; entry.resolvedAt = Date.now();
      this.log(`请求 ${entry.code} 已结束`);
      if (entry.announcedEpoch === this.notificationEpoch) this.enqueue(current => this.send(`Codex【${entry.code}】已处理或已结束，后续回复不再生效。`, current));
    }
    // Keep recent tombstones for clear replies, without growing for the lifetime of the service.
    for (const [key, entry] of this.entries) if (entry.resolvedAt < Date.now() - 86400000) { this.entries.delete(key); this.codes.delete(entry.code); }
    this.flushNotifications();
  }
  flushNotifications() {
    if (!this.messenger.ready) return;
    for (const notification of this.store.data.outbox) {
      if (this.notifying.has(notification.key)) continue;
      this.notifying.add(notification.key);
      this.enqueue(async current => {
        try {
          const pending = () => current() && this.store.data.outbox.includes(notification);
          if (await this.send(renderCompletion(notification), pending)) this.store.delivered(notification.key);
        }
        finally { this.notifying.delete(notification.key); }
      });
    }
  }
  notifyReady({ reconnect = false } = {}) {
    if (reconnect) {
      this.notificationEpoch++;
      for (const entry of this.entries.values()) if (!entry.resolved) {
        entry.announcing = false; entry.available = false;
      }
    }
    for (const thread of this.desktop.threads.values()) if (thread.fresh) this.observe(thread);
    if (reconnect) {
      const discarded = this.store.discardNotifications();
      this.log(`微信消息上下文已刷新；清理 ${discarded} 条积压结果通知，仅同步当前待处理审批和问题。`);
    }
    this.flushNotifications();
  }
  pending() { return [...this.entries.values()].filter(e => !e.resolved); }
  threadFor(chat) { return this.desktop.threads.get(`${chat.hostId}:${chat.id}`); }
  renderStatus() {
    const chats = this.store.data.chats;
    if (!chats.length) return '尚未同步到桌面聊天，请在 Codex 桌面打开聊天后重试。';
    const lines = [`已同步 ${chats.length} 个聊天；待处理 ${this.pending().length} 项。`];
    for (const chat of chats) {
      const thread = this.threadFor(chat), turn = thread?.state && latestTurn(thread.state);
      const pending = this.pending().filter(e => e.chatCode === chat.code);
      const status = !thread?.fresh ? '连接不可用'
        : pending.length ? `等待${pending.some(approval) ? '审批' : '回答'}（${pending.length}项）`
        : turn?.status === 'inProgress' || thread.state.threadRuntimeStatus?.type === 'active' ? '正在运行'
        : turn?.status === 'failed' ? '上轮失败'
        : ['interrupted', 'cancelled'].includes(turn?.status) ? '上轮中断' : '空闲';
      lines.push(`【聊天${chat.code}】${thread?.state?.title || chat.id}${this.store.data.selected === chat.code ? '（当前）' : ''}\n${status}`);
    }
    lines.push('选择：切换1；指定发送：继续1 你的要求；审批/问题：待处理');
    return lines.join('\n');
  }
  renderPending() {
    const pending = this.pending();
    if (!pending.length) return '当前没有已同步的待处理审批或问题。';
    return pending.map(e => {
      const p = e.request.params ?? {}, preview = p.command ?? p.questions?.[0]?.question ?? p.reason ?? '';
      return `【${e.code}】${requestType(e)} · 聊天${e.chatCode}：${e.title || e.threadId}${!e.available ? '（连接不可用）' : e.submitted ? '（已提交，等待桌面同步）' : ''}\n${String(preview).slice(0, 140)}\n${approval(e) ? `同意${e.code} / 拒绝${e.code}` : `回答${e.code} 你的答案`}`;
    }).join('\n\n');
  }
  async onText(text) {
    text = text.trim();
    if (['帮助', 'help'].includes(text)) { await this.send(HELP); return; }
    if (['状态', '聊天', '任务'].includes(text)) { await this.send(this.renderStatus()); return; }
    if (['待处理', '待办'].includes(text)) { await this.send(this.renderPending()); return; }
    const selection = text.match(/^切换\s*(\d+)$/);
    if (selection) {
      const chat = this.store.data.chats.find(c => c.code === selection[1]);
      if (!chat || !this.threadFor(chat)?.fresh) { await this.send('聊天编号无效或连接不可用，请发送“状态”查看。'); return; }
      this.store.select(chat.code);
      await this.send(`已切换到【聊天${chat.code}】${this.threadFor(chat).state.title || chat.id}。接下来直接发送文字即可，桌面聊天也会显示。`);
      return;
    }
    let reply = parseReply(text);
    const bare = /^(同意|批准|拒绝)$/.test(text);
    if (bare) {
      const candidates = this.pending().filter(approval);
      if (candidates.length !== 1 || !candidates[0].available || !candidates[0].announced) {
        await this.send(candidates.length > 1 ? `当前有 ${candidates.length} 条待审批，请带编号回复，避免处理错任务。\n${this.renderPending()}` : '当前没有唯一且已通知的可处理审批，请发送“待处理”查看。'); return;
      }
      reply = { action: text === '批准' ? '同意' : text, code: candidates[0].code, answer: '' };
    }
    if (reply) { await this.submitReply(reply, bare); return; }
    if (/^(同意|批准|拒绝|回答|切换)/.test(text)) { await this.send(HELP); return; }
    const continuation = text.match(/^继续\s*(\d+)(?:\s+([\s\S]+))?$/);
    if (continuation && !continuation[2]) { await this.send(`请在编号后填写内容，例如：继续${continuation[1]} 把测试也跑一下`); return; }
    await this.continueChat(continuation?.[1], continuation?.[2] ?? text.replace(/^继续\s+/, ''));
  }
  async submitReply(reply, bare = false) {
    const entry = this.codes.get(reply.code);
    if (!entry || entry.resolved) { await this.send(`【${reply.code}】已结束或编号已失效，请查看最新通知。`); return; }
    if (!entry.available) { await this.send(`【${reply.code}】桌面连接未就绪，请在桌面处理。`); return; }
    if (this.busy.has(entry.key) || entry.submitted) { await this.send(`【${reply.code}】正在提交或等待桌面同步，请勿重复操作。`); return; }
    this.busy.add(entry.key);
    try {
      const response = buildResponse(entry.request, reply);
      const result = await this.desktop.reply(entry, response, () => {
        if (bare) {
          const candidates = this.pending().filter(approval);
          if (candidates.length !== 1 || candidates[0] !== entry) throw Error('待审批列表发生变化，请发送“待处理”后带编号回复');
        }
      });
      entry.submitted = !result.alreadyResolved;
      this.log(`微信回复 ${reply.code}：${result.alreadyResolved ? '已结束，未重复提交' : '已交给桌面实例'}`);
      await this.send(result.alreadyResolved ? `【${reply.code}】已在桌面处理或已结束。` : `【${reply.code}】回复已提交；若桌面先处理，以桌面结果为准。`);
    } catch (error) { await this.send(`【${reply.code}】${error.message}`); }
    finally { this.busy.delete(entry.key); }
  }
  async continueChat(code, text) {
    if (!text || /^\d+$/.test(text)) { await this.send(HELP); return; }
    let chat = this.store.data.chats.find(c => c.code === (code ?? this.store.data.selected));
    if (!chat && !code && !this.store.data.selected) {
      const available = this.store.data.chats.filter(c => this.threadFor(c)?.fresh);
      if (available.length === 1) chat = available[0];
    }
    if (!chat) { await this.send(`请先选择要继续的聊天，消息尚未提交。\n${this.renderStatus()}`); return; }
    if (!this.threadFor(chat)?.fresh) { await this.send(`【聊天${chat.code}】连接不可用，请在桌面打开后重试。消息尚未提交。`); return; }
    if (this.chatBusy.has(chat.key)) { await this.send(`【聊天${chat.code}】上一条消息还在提交，请稍后再发。`); return; }
    this.chatBusy.add(chat.key);
    try {
      const result = await this.desktop.continueChat(chat, text);
      this.store.select(chat.code);
      this.log(`微信消息已提交到聊天${chat.code}（${result.active ? '活动回合' : '新回合'}）`);
      await this.send(`已发送到【聊天${chat.code}】${this.threadFor(chat).state.title || chat.id}。${result.active ? '已追加到正在执行的回合。' : '已开始新回合。'}完成或失败后会通知你。`);
    } catch (error) { await this.send(`【聊天${chat.code}】${error.message}。如提示 timeout 或断线，请先检查桌面是否已收到，避免重复发送。`); }
    finally { this.chatBusy.delete(chat.key); }
  }
}
