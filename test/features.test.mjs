import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Bridge } from '../src/bridge.mjs';
import { Desktop, projectState, applyRequestPatches } from '../src/desktop.mjs';
import { BridgeStore, conversationTurns, renderCompletion } from '../src/activity.mjs';

const command = id => ({ id, method: 'item/commandExecution/requestApproval', params: { command: 'npm test' } });
const turn = (status = 'inProgress', extra = {}) => ({ turnId: 'turn-1', status, turnStartedAtMs: Date.now(), items: [], ...extra });
const state = (turns = [], requests = []) => ({ title: '桥接测试', cwd: 'C:/test', requests, turns });
function setup({ store = new BridgeStore(), ready = true } = {}) {
  const desktop = new EventEmitter(); desktop.threads = new Map();
  const messages = [], replies = [], continuations = [];
  desktop.reply = async (entry, response, validate) => { validate(); replies.push({ entry, response }); return { submitted: true }; };
  desktop.continueChat = async (chat, text) => { continuations.push({ chat, text }); return { active: true }; };
  const messenger = { ready, send: async text => messages.push(text) };
  const bridge = new Bridge({ desktop, messenger, store, log: () => {} });
  const update = (id, raw) => { const thread = { id, hostId: 'local', fresh: true, state: projectState(raw) }; desktop.threads.set(`local:${id}`, thread); desktop.emit('state', thread); return thread; };
  return { desktop, bridge, store, messenger, messages, replies, continuations, update };
}

test('only one announced approval accepts an unnumbered response', async () => {
  const h = setup(); h.update('a', state([], [command('r')])); await h.bridge.queue;
  await h.bridge.onText('同意'); await h.bridge.onText('同意');
  assert.equal(h.replies.length, 1); assert.equal(h.replies[0].entry.threadId, 'a');
  assert.match(h.messages.at(-1), /请勿重复/);
});

test('multiple approvals, including an unavailable chat, require a code', async () => {
  const h = setup(); h.update('a', state([], [command('r')]));
  const b = h.update('b', state([], [command('r')])); await h.bridge.queue;
  b.fresh = false; h.desktop.emit('unavailable', b);
  await h.bridge.onText('拒绝');
  assert.equal(h.replies.length, 0); assert.match(h.messages.at(-1), /2 条待审批/);
});

test('a question is never selected by the unnumbered approval shortcut', async () => {
  const h = setup(); h.update('a', state([], [{ id: 'q', method: 'item/tool/requestUserInput', params: { questions: [{ id: 'q1', question: '选哪个？' }] } }])); await h.bridge.queue;
  await h.bridge.onText('同意'); assert.equal(h.replies.length, 0);
  assert.match(h.messages.at(-1), /没有唯一/);
});

test('a second approval arriving during refresh cancels an unnumbered response', async () => {
  const h = setup(); h.update('a', state([], [command('r')])); await h.bridge.queue;
  h.desktop.reply = async (_entry, _response, validate) => { h.update('b', state([], [command('r2')])); validate(); h.replies.push('wrong'); return {}; };
  await h.bridge.onText('同意'); assert.equal(h.replies.length, 0);
  assert.ok(h.messages.some(m => m.includes('待审批列表发生变化'))); await h.bridge.queue;
});

test('an approval resolved on desktop cannot be selected by the shortcut', async () => {
  const h = setup(); h.update('a', state([], [command('r')])); await h.bridge.queue;
  h.update('a', state()); await h.bridge.queue; await h.bridge.onText('同意');
  assert.equal(h.replies.length, 0);
});

test('status distinguishes running, waiting, failed, and unavailable chats', async () => {
  const h = setup(); h.update('a', state([turn()])); h.update('b', state([], [command('r')]));
  h.update('c', state([turn('failed')])); const d = h.update('d', state());
  d.fresh = false; h.desktop.emit('unavailable', d); await h.bridge.queue;
  await h.bridge.onText('状态');
  for (const label of ['聊天1', '正在运行', '等待审批', '上轮失败', '连接不可用']) assert.ok(h.messages.at(-1).includes(label));
  await h.bridge.onText('待处理'); assert.match(h.messages.at(-1), /命令审批 · 聊天2/);
});

test('multiple chats never guess a destination for plain text', async () => {
  const h = setup(); h.update('a', state()); h.update('b', state());
  await h.bridge.onText('把测试也跑一下');
  assert.equal(h.continuations.length, 0); assert.match(h.messages.at(-1), /消息尚未提交/);
});

test('chat selection routes plain text and explicit continuation changes selection', async () => {
  const h = setup(); h.update('a', state()); h.update('b', state());
  await h.bridge.onText('切换2'); await h.bridge.onText('把测试也跑一下');
  assert.equal(h.continuations[0].chat.id, 'b');
  await h.bridge.onText('继续1 改成第二种方案'); await h.bridge.onText('继续');
  assert.deepEqual(h.continuations.slice(1).map(c => [c.chat.id, c.text]), [['a', '改成第二种方案'], ['a', '继续']]);
});

test('disconnected selected chat is never replaced with a different available chat', async () => {
  const h = setup(); const a = h.update('a', state()); h.update('b', state());
  await h.bridge.onText('切换1'); a.fresh = false; h.desktop.emit('unavailable', a);
  await h.bridge.onText('继续修复'); assert.equal(h.continuations.length, 0); assert.match(h.messages.at(-1), /连接不可用/);
});

test('malformed control messages never become a chat instruction', async () => {
  const h = setup(); h.update('a', state());
  for (const text of ['同意abc', '回答102', '切换abc', '继续1', '999']) await h.bridge.onText(text);
  assert.equal(h.continuations.length, 0); assert.equal(h.replies.length, 0);
});

test('initial completed history is silent and only newly completed turns notify once', async () => {
  const h = setup(); const old = turn('completed', { turnId: 'old', turnStartedAtMs: 1 });
  h.update('a', state([old, turn()])); await h.bridge.queue; assert.equal(h.messages.length, 0);
  const done = turn('completed', { items: [{ type: 'agentMessage', id: 'final', phase: 'final_answer', text: '测试通过。' }] });
  h.update('a', state([old, done])); h.update('a', state([old, done])); await h.bridge.queue;
  assert.equal(h.messages.length, 1); assert.match(h.messages[0], /本轮完成【聊天1】/); assert.match(h.messages[0], /测试通过/);
  h.update('a', state([old, done])); await h.bridge.queue; assert.equal(h.messages.length, 1);
});

test('a failed tool does not imply a failed turn', async () => {
  const h = setup(); const current = turn('inProgress', { items: [{ type: 'commandExecution', id: 'cmd', status: 'failed', aggregatedOutput: 'private output' }] });
  h.update('a', state([current])); await h.bridge.queue; assert.equal(h.messages.length, 0);
  current.status = 'completed'; current.items.push({ type: 'agentMessage', id: 'final', phase: 'final_answer', text: '已修复并通过测试。' });
  h.update('a', state([current])); await h.bridge.queue;
  assert.match(h.messages[0], /本轮完成/); assert.ok(!h.messages[0].includes('本轮失败')); assert.ok(!h.messages[0].includes('private output'));
});

test('turn failure notifies its actual error without exposing reasoning', async () => {
  const h = setup(); h.update('a', state([turn()]));
  h.update('a', state([turn('failed', { error: { message: '模型连接失败', additionalDetails: 'private details' }, items: [{ type: 'reasoning', text: 'private reasoning' }] })]));
  await h.bridge.queue; assert.match(h.messages[0], /本轮失败/); assert.match(h.messages[0], /模型连接失败/);
  assert.ok(!h.messages[0].includes('private'));
});

test('offline results remain in outbox and ready callback flushes them once', async () => {
  const h = setup({ ready: false }); h.update('a', state([turn()])); h.update('a', state([turn('completed')])); await h.bridge.queue;
  assert.equal(h.messages.length, 0); assert.equal(h.store.data.outbox.length, 1);
  h.messenger.ready = true; h.bridge.notifyReady(); await h.bridge.queue;
  assert.equal(h.messages.length, 1); assert.equal(h.store.data.outbox.length, 0);
});

test('failed delivery is retained and can be retried without duplicate queued sends', async () => {
  const h = setup(); h.update('a', state([turn()]));
  h.messenger.send = async () => { throw Error('network offline'); };
  h.update('a', state([turn('completed')])); await h.bridge.queue;
  assert.equal(h.store.data.outbox.length, 1);
  h.messenger.send = async text => h.messages.push(text);
  h.bridge.flushNotifications(); h.bridge.flushNotifications(); await h.bridge.queue;
  assert.equal(h.messages.length, 1); assert.equal(h.store.data.outbox.length, 0);
});

test('result state, selected chat, and pending notifications survive restart', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url)), dir = fs.mkdtempSync(path.join(root, 'test-state-')), file = path.join(dir, 'state.json');
  try {
    let h = setup({ store: new BridgeStore(file), ready: false }); h.update('a', state([turn()])); h.store.select('1');
    h = setup({ store: new BridgeStore(file), ready: false }); h.update('a', state([turn('completed')]));
    assert.equal(h.store.data.outbox.length, 1); assert.equal(h.store.data.selected, '1'); assert.equal(h.store.data.chats.length, 1);
    h = setup({ store: new BridgeStore(file) }); h.bridge.notifyReady(); await h.bridge.queue; assert.equal(h.messages.length, 1);
    h = setup({ store: new BridgeStore(file) }); h.update('a', state([turn('completed')])); await h.bridge.queue; assert.equal(h.messages.length, 0);
    h.update('b', state()); assert.equal(h.store.data.chats[1].code, '2');
  } finally { fs.unlinkSync(file); fs.rmdirSync(dir); }
});

test('old history loaded after initial snapshot never creates completion spam', async () => {
  const h = setup(); h.update('a', state()); h.update('a', state([turn('completed', { turnStartedAtMs: 1 })]));
  await h.bridge.queue; assert.equal(h.messages.length, 0);
});

test('a very fast turn first seen completed after subscription still notifies', async () => {
  const h = setup(); h.update('a', state()); h.update('a', state([turn('completed')]));
  await h.bridge.queue; assert.equal(h.messages.length, 1);
});

test('canonical and legacy turn history are deduplicated and ordered', () => {
  const older = turn('completed', { turnId: 'old', turnStartedAtMs: 1 }), newer = turn('inProgress', { turnId: 'new', turnStartedAtMs: 2 });
  const projected = projectState({ ...state([older, newer]), turnHistory: { kind: 'canonical', history: { entitiesByKey: { new: newer, old: older } } } });
  assert.deepEqual(conversationTurns(projected).map(t => t.turnId), ['old', 'new']);
});

test('final text patches and runtime status are retained; commentary and output are discarded', () => {
  let s = projectState(state([turn('inProgress', { items: [{ type: 'agentMessage', id: 'c', phase: 'commentary', text: 'private commentary' }, { type: 'agentMessage', id: 'f', phase: 'final_answer', text: '' }] })]));
  s = applyRequestPatches(s, [{ op: 'replace', path: ['turns', 0, 'items', 1, 'text'], value: '完成内容' }, { op: 'replace', path: ['turns', 0, 'items', 0, 'text'], value: 'private commentary delta' }, { op: 'replace', path: ['threadRuntimeStatus'], value: { type: 'idle' } }]);
  assert.equal(s.turns[0].items[1].text, '完成内容'); assert.equal(s.threadRuntimeStatus.type, 'idle'); assert.ok(!JSON.stringify(s).includes('private'));
});

function nativeDesktop(raw) {
  const ipc = new EventEmitter(), calls = [], desktop = new Desktop({ ipc });
  ipc.request = async (...args) => { calls.push(args); return { result: { result: {} } }; };
  const thread = { id: 'a', hostId: 'local', fresh: true, owner: 'desktop-owner', state: projectState(raw) };
  desktop.threads.set('local:a', thread); desktop.refresh = async () => thread;
  return { desktop, calls, thread };
}

test('idle continuation uses native start-turn and inherits model and approval settings', async () => {
  const h = nativeDesktop(state([turn('completed')]));
  assert.deepEqual(await h.desktop.continueChat({ hostId: 'local', id: 'a' }, '跑测试'), { active: false });
  const [method, params, options] = h.calls[0]; assert.equal(method, 'thread-follower-start-turn'); assert.equal(options.targetClientId, 'desktop-owner');
  assert.deepEqual(params.turnStart.request.input, [{ type: 'text', text: '跑测试', text_elements: [] }]);
  assert.equal(params.turnStart.context.inheritThreadSettings, true);
  for (const field of ['model', 'permissions', 'approvalPolicy', 'sandboxPolicy']) assert.ok(!(field in params.turnStart.request));
});

test('active continuation uses native steer and preserves desktop restore message', async () => {
  const h = nativeDesktop(state([turn()])); await h.desktop.continueChat({ hostId: 'local', id: 'a' }, '改成方案二');
  const [method, params] = h.calls[0]; assert.equal(method, 'thread-follower-steer-turn'); assert.equal(params.restoreMessage.text, '改成方案二'); assert.deepEqual(params.input[0].text_elements, []);
});

test('continuation refreshes first and never bypasses an approval or question', async () => {
  const h = nativeDesktop(state()); h.desktop.refresh = async () => ({ ...h.thread, state: projectState(state([], [command('r')])) });
  await assert.rejects(h.desktop.continueChat({ hostId: 'local', id: 'a' }, '继续'), /先发送“待处理”/); assert.equal(h.calls.length, 0);
});

test('continuation rejects unavailable chats and a runtime between turns', async () => {
  const h = nativeDesktop({ ...state(), threadRuntimeStatus: { type: 'active' } });
  await assert.rejects(h.desktop.continueChat({ hostId: 'local', id: 'a' }, '继续'), /切换回合/);
  h.thread.fresh = false; await assert.rejects(h.desktop.continueChat({ hostId: 'local', id: 'a' }, '继续'), /未就绪/); assert.equal(h.calls.length, 0);
});

test('completion labels interrupted turns honestly and bounds long summaries', () => {
  assert.match(renderCompletion({ chatCode: '1', title: '测试', status: 'interrupted', summary: '', error: '' }), /本轮中断/);
});
