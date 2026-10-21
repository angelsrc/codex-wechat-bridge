import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Bridge } from '../src/bridge.mjs';
import { Desktop, projectState, applyRequestPatches } from '../src/desktop.mjs';
import { FrameReader, encodeFrame } from '../src/ipc.mjs';
import { buildResponse, splitMessage } from '../src/requests.mjs';
import { WeixinMessenger, WeixinApi, validateBase, parseApiJson } from '../src/weixin.mjs';
import { pendingRequests } from '../src/questions.mjs';
import { parseReply } from '../src/requests.mjs';
import { createCodeGenerator } from '../src/codes.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const command = { id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { command: 'make test', cwd: 'E:/project', availableDecisions: ['accept', 'decline'] } };
function setup(send = async () => {}) {
  const desktop = new EventEmitter(); desktop.threads = new Map(); let calls = 0;
  desktop.reply = async () => { calls++; return { submitted: true }; };
  const messages = [], messenger = { ready: true, send: async text => { messages.push(text); await send(text); } };
  const bridge = new Bridge({ desktop, messenger, log: () => {} });
  const thread = { id: 'thread-1', hostId: 'local', fresh: true, state: { title: '项目甲', cwd: 'E:/project', requests: [command] } };
  desktop.threads.set('local:thread-1', thread); desktop.emit('state', thread);
  return { desktop, bridge, thread, messages, calls: () => calls };
}

test('slow WeChat delivery never blocks desktop resolution or sends a stale quick reply', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const { desktop, bridge, thread, messages } = setup(() => gate);
  await Promise.resolve();
  thread.state.requests = []; desktop.emit('state', thread);
  assert.equal([...bridge.entries.values()][0].resolved, true);
  release(); await bridge.queue;
  assert.ok(!messages.includes('同意101'));
});

test('compact numeric replies and legacy codes parse without requiring spaces', () => {
  assert.deepEqual(parseReply('同意101'), { action: '同意', code: '101', answer: '' });
  assert.deepEqual(parseReply('拒绝 102'), { action: '拒绝', code: '102', answer: '' });
  assert.deepEqual(parseReply('回答103 2\n超时 30 秒'), { action: '回答', code: '103', answer: '2\n超时 30 秒' });
  assert.deepEqual(parseReply('批准0123abcd'), { action: '同意', code: '0123ABCD', answer: '' });
  assert.equal(parseReply('同意'), null);
  assert.equal(parseReply('同意101abc'), null);
});

test('approval has a standalone message that can be copied and submitted directly', async () => {
  const { bridge, messages, calls } = setup(); await bridge.queue;
  assert.match(messages[0], /拒绝101/);
  assert.equal(messages[1], '同意101');
  await bridge.onText(messages[1]); assert.equal(calls(), 1);
});

test('short codes persist across restart and never reuse old numbers', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const dir = fs.mkdtempSync(path.join(root, 'test-codes-')), file = path.join(dir, 'counter.json');
  try {
    let generate = createCodeGenerator(file);
    assert.equal(generate(), '101'); assert.equal(generate(), '102');
    generate = createCodeGenerator(file);
    assert.equal(generate(), '103');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).next, 104);
  } finally { fs.unlinkSync(file); fs.rmdirSync(dir); }
});

test('short codes grow after 999 instead of wrapping to an old request', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const dir = fs.mkdtempSync(path.join(root, 'test-codes-')), file = path.join(dir, 'counter.json');
  try {
    fs.writeFileSync(file, JSON.stringify({ next: 999 }));
    const generate = createCodeGenerator(file);
    assert.equal(generate(), '999'); assert.equal(generate(), '1000');
  } finally { fs.unlinkSync(file); fs.rmdirSync(dir); }
});

test('invalid persisted numbering fails rather than resetting and reusing codes', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const dir = fs.mkdtempSync(path.join(root, 'test-codes-')), file = path.join(dir, 'counter.json');
  try {
    fs.writeFileSync(file, JSON.stringify({ next: null }));
    assert.throws(() => createCodeGenerator(file), /编号记录无效/);
  } finally { fs.unlinkSync(file); fs.rmdirSync(dir); }
});

test('desktop-first resolution rejects late WeChat reply without dispatch', async () => {
  const { desktop, bridge, thread, calls, messages } = setup(); await bridge.queue;
  const code = [...bridge.codes.keys()][0];
  thread.state.requests = []; desktop.emit('state', thread); await bridge.queue;
  await bridge.onText(`同意 ${code}`);
  assert.equal(calls(), 0); assert.match(messages.at(-1), /已结束/);
});

test('concurrent duplicate replies dispatch at most once', async () => {
  const { desktop, bridge } = setup(); await bridge.queue;
  let release, calls = 0; desktop.reply = async () => { calls++; await new Promise(resolve => { release = resolve; }); return { submitted: true }; };
  const code = [...bridge.codes.keys()][0], first = bridge.onText(`同意 ${code}`);
  await bridge.onText(`同意 ${code}`); assert.equal(calls, 1);
  release(); await first;
});

test('same request ID in two chats cannot cross-route', async () => {
  const { desktop, bridge, thread } = setup();
  desktop.emit('state', { ...thread, id: 'thread-2', state: { ...thread.state, title: '项目乙' } }); await bridge.queue;
  const entries = [...bridge.entries.values()]; assert.equal(entries.length, 2); assert.notEqual(entries[0].code, entries[1].code);
  let target; desktop.reply = async entry => { target = entry.threadId; return {}; };
  await bridge.onText(`拒绝 ${entries[1].code}`); assert.equal(target, 'thread-2');
});

test('disconnect disables remote actions and reconnect restores pending requests', async () => {
  const { desktop, bridge, thread, calls } = setup(); await bridge.queue;
  const code = [...bridge.codes.keys()][0]; desktop.emit('unavailable', thread);
  await bridge.onText(`同意 ${code}`); assert.equal(calls(), 0);
  desktop.emit('state', thread); await bridge.onText(`同意 ${code}`); assert.equal(calls(), 1);
});

test('native question returns selected label and free text in their own slots', () => {
  const request = { method: 'item/tool/requestUserInput', params: { questions: [{ id: 'a', options: [{ label: '方案一' }, { label: '方案二' }] }, { id: 'b' }] } };
  const result = buildResponse(request, { action: '回答', answer: '2\n超时设为 30 秒' });
  assert.equal(result.method, 'thread-follower-submit-user-input');
  assert.deepEqual(result.payload.response.answers, { a: { answers: ['方案二'] }, b: { answers: ['超时设为 30 秒'] } });
  assert.throws(() => buildResponse(request, { action: '回答', answer: '只有一个答案' }), /2 个答案/);
});

test('remote approval only grants the current request, never permanent approval', () => {
  assert.deepEqual(buildResponse(command, { action: '同意' }).payload, { decision: 'accept' });
  assert.throws(() => buildResponse(command, { action: '回答', answer: 'acceptForSession' }), /审批/);
  assert.throws(() => buildResponse({ ...command, params: { availableDecisions: ['cancel'] } }, { action: '同意' }), /不提供/);
});

test('frame parser handles fragmented UTF-8 and multiple coalesced messages', () => {
  const frames = Buffer.concat([encodeFrame({ text: '审批🙂' }), encodeFrame({ id: 2 })]), received = [];
  const reader = new FrameReader(m => received.push(m));
  for (const byte of frames) reader.push(Buffer.of(byte));
  assert.deepEqual(received, [{ text: '审批🙂' }, { id: 2 }]);
  assert.throws(() => new FrameReader(() => {}).push(Buffer.alloc(4)), /length/);
});

test('patches discard history and block prototype mutation', () => {
  const state = projectState({ id: 't', requests: [command], turns: ['private history'] });
  const result = applyRequestPatches(state, [{ op: 'replace', path: ['turns', 0], value: 'ignored' }, { op: 'remove', path: ['requests', 0] }]);
  assert.deepEqual(result.requests, []); assert.ok(!JSON.stringify(result.turns).includes('private history'));
  assert.throws(() => applyRequestPatches(result, [{ op: 'add', path: ['requests', '__proto__'], value: {} }]), /Invalid/);
});

test('revision gaps disable replies and request a fresh snapshot', () => {
  const ipc = new EventEmitter(); const sent = []; ipc.broadcast = (...args) => sent.push(args);
  const desktop = new Desktop({ ipc }); const thread = { id: 't', hostId: 'local', owner: 'owner', fresh: true, revision: 1, state: { requests: [command] } };
  desktop.threads.set('local:t', thread);
  desktop.onBroadcast({ type: 'broadcast', method: 'thread-stream-state-changed', version: 11, sourceClientId: 'owner', params: { conversationId: 't', hostId: 'local', change: { type: 'patches', baseRevision: 4, revision: 5, patches: [] } } });
  assert.equal(thread.fresh, false); assert.equal(sent[0][0], 'thread-stream-following-changed');
});

test('desktop state from an unrelated IPC client is ignored', () => {
  const ipc = new EventEmitter(), desktop = new Desktop({ ipc }); const thread = { id: 't', hostId: 'local', owner: 'owner', fresh: true, revision: 1, state: { requests: [command] } };
  desktop.threads.set('local:t', thread);
  desktop.onBroadcast({ method: 'thread-stream-state-changed', version: 11, sourceClientId: 'other-client', params: { conversationId: 't', hostId: 'local', change: { type: 'snapshot', revision: 2, conversationState: { requests: [] } } } });
  assert.equal(thread.state.requests.length, 1);
});

test('desktop rechecks pending state immediately before dispatch', async () => {
  const ipc = new EventEmitter(), desktop = new Desktop({ ipc }); let writes = 0;
  ipc.request = async () => { writes++; return {}; };
  const thread = { id: 't', hostId: 'local', owner: 'owner', fresh: true, state: { requests: [command] } }; desktop.threads.set('local:t', thread);
  desktop.refresh = async () => ({ ...thread, state: { requests: [] } });
  assert.deepEqual(await desktop.reply({ threadId: 't', hostId: 'local', request: command }, { method: 'ignored', payload: {} }), { alreadyResolved: true });
  assert.equal(writes, 0);
});

test('WeChat accepts only bound user and deduplicates repeated delivery', async () => {
  const messenger = new WeixinMessenger({ account: { userId: 'me' }, saveState: async () => {} });
  let calls = 0; const message = { message_id: '18446744073709551614', from_user_id: 'me', message_type: 1, context_token: 'context', item_list: [{ type: 1, text_item: { text: '同意 0123ABCD' } }] };
  await messenger.consume({ ...message, from_user_id: 'other' }, async () => { calls++; });
  assert.equal(messenger.ready, false);
  await messenger.consume(message, async () => { calls++; }); await messenger.consume(message, async () => { calls++; });
  assert.equal(calls, 1); assert.equal(messenger.state.contextToken, 'context');
});

test('outgoing messages always use the paired recipient and latest context', async () => {
  let sent; const api = { request: async (_endpoint, options) => { sent = options; } };
  const messenger = new WeixinMessenger({ api, account: { userId: 'me', token: 'secret', baseUrl: 'https://ilinkai.weixin.qq.com' }, state: { contextToken: 'latest' } });
  await messenger.send('hello'); assert.equal(sent.body.msg.to_user_id, 'me'); assert.equal(sent.body.msg.context_token, 'latest');
  assert.throws(() => validateBase('http://ilinkai.weixin.qq.com')); assert.throws(() => validateBase('https://weixin.qq.com.attacker.invalid'));
});

test('HTTP and business errors stay visible without including bot credentials', async () => {
  const api = new WeixinApi({ fetchFn: async () => ({ ok: true, text: async () => JSON.stringify({ ret: -14, errmsg: 'not logged' }) }) });
  await assert.rejects(api.request('endpoint', { body: {}, token: 'supersecret' }), /微信接口错误 -14/);
});

test('uint64 message IDs stay exact while message text is untouched', () => {
  const raw = '{"msgs":[{"message_id":18446744073709551614,"text":"\\\"message_id\\\":123"},{"message_id":18446744073709551615}]}';
  const data = parseApiJson(raw);
  assert.equal(data.msgs[0].message_id, '18446744073709551614');
  assert.equal(data.msgs[1].message_id, '18446744073709551615');
  assert.equal(data.msgs[0].text, '"message_id":123');
});

test('async question cards in canonical history become replyable and desktop answers remove them', () => {
  const questionItemId = JSON.stringify(['request_user_input_async', 'item-qa', 0]);
  const turn = { turnId: 'active-turn', status: 'inProgress', items: [{ type: 'agentMessage', id: 'item-qa', text: 'private conversation', questions: [{ title: '选择验证方式', options: ['微信', '桌面'] }] }] };
  let state = projectState({ id: 't', requests: [], turns: [], turnHistory: { kind: 'canonical', history: { entitiesByKey: { tail: turn } } } });
  const request = pendingRequests(state)[0];
  assert.equal(request.method, 'desktop/asyncQuestion');
  assert.equal(request.params.questionItemId, questionItemId);
  const response = buildResponse(request, { action: '回答', answer: '1' });
  assert.equal(response.method, 'thread-follower-steer-turn');
  assert.deepEqual(response.payload.input[0].text_elements, []);
  assert.match(response.payload.input[0].text, /微信/);
  assert.ok(!JSON.stringify(state).includes('private conversation'));
  state = applyRequestPatches(state, [{ op: 'add', path: ['turnHistory', 'history', 'entitiesByKey', 'tail', 'items', 1], value: { type: 'steeringUserMessage', status: 'accepted', id: 'reply', input: response.payload.input } }]);
  assert.equal(pendingRequests(state).length, 0);
});

test('completed turns cannot reissue unanswered asynchronous questions', () => {
  const state = projectState({ requests: [], turns: [{ turnId: 'old', status: 'completed', items: [{ type: 'agentMessage', id: 'qa', questions: [{ title: '旧问题', options: [] }] }] }] });
  assert.deepEqual(pendingRequests(state), []);
});

test('long command previews are split without dropping or corrupting text', () => {
  const text = '🙂测试'.repeat(3000); const parts = splitMessage(text, 500);
  assert.equal(parts.map(s => s.replace(/^\(\d+\/\d+\)\n/, '')).join(''), text);
  assert.ok(parts.every(s => Buffer.byteLength(s) < 530));
});
