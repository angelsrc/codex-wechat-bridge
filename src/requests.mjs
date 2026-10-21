import { asyncAnswerText } from './questions.mjs';

export const SUPPORTED = new Set([
  'item/commandExecution/requestApproval', 'item/fileChange/requestApproval',
  'item/permissions/requestApproval', 'item/tool/requestUserInput', 'mcpServer/elicitation/request',
  'desktop/asyncQuestion',
]);

export function requestKey(hostId, threadId, request) { return JSON.stringify([hostId, threadId, request.id, request.method]); }

export function renderRequest(entry) {
  const { request, code, title, cwd } = entry, p = request.params ?? {};
  const question = request.method === 'item/tool/requestUserInput' || request.method === 'desktop/asyncQuestion';
  const lines = [`Codex ${question ? '需要回答' : '等待审批'}【${code}】`, `聊天${entry.chatCode ?? ''}：${title || entry.threadId}`, cwd ? `目录：${cwd}` : ''];
  if (question) {
    for (const [index, q] of (p.questions ?? []).entries()) {
      lines.push('', `${index + 1}. ${q.header ? `${q.header}：` : ''}${q.question}`);
      for (const [i, option] of (q.options ?? []).entries()) lines.push(`  ${i + 1}) ${option.label}${option.description ? ` — ${option.description}` : ''}`);
    }
    lines.push('', '回复示例（编号后留空格，再填答案）：', `回答${code} 你的答案`, '多道问题用换行依次填写；单个数字表示选择对应选项。');
  } else {
    const preview = { ...p }; delete preview.threadId; delete preview.turnId; delete preview.itemId;
    lines.push('', JSON.stringify(preview, null, 2));
    if (request.method === 'mcpServer/elicitation/request' && p.mode !== 'url') lines.push('', '表单内容用 JSON 回复：', `回答${code} {…}`, '也可以拒绝：', `拒绝${code}`);
    else lines.push('', '直接输入或复制发送：', `同意${code}`, `拒绝${code}`, '只有一条待审批时，也可直接回复“同意”或“拒绝”。', '下一条独立消息可长按复制，发送后才会批准。', '同意仅作用于本次请求。');
  }
  lines.push('桌面端可同时处理；已结束的请求不会再次执行。');
  return lines.filter(x => x !== undefined).join('\n');
}

export function quickApprovalReply(entry) {
  if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval'].includes(entry.request.method) || entry.request.method === 'mcpServer/elicitation/request' && entry.request.params?.mode === 'url') return `同意${entry.code}`;
  return null;
}

export function parseReply(text) {
  const match = text.trim().match(/^(同意|批准|拒绝|回答)\s*([0-9]+|[A-Fa-f0-9]{8})(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  return { action: match[1] === '批准' ? '同意' : match[1], code: match[2].toUpperCase(), answer: match[3]?.trim() ?? '' };
}

function answersFor(questions, text) {
  if (!questions.length) throw Error('此提问没有可识别的问题，请在桌面处理');
  const parts = questions.length === 1 ? [text] : text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (parts.length !== questions.length || parts.some(s => !s)) throw Error(`请依次填写 ${questions.length} 个答案，每个答案一行`);
  const answers = [];
  for (const [i, q] of questions.entries()) {
    let value = parts[i];
    if (/^[1-9]\d*$/.test(value) && q.options?.length) {
      const option = q.options[Number(value) - 1];
      if (!option) throw Error(`第 ${i + 1} 个答案的选项编号无效`);
      value = option.label;
    }
    answers.push([q.id, { answers: [value] }]);
  }
  return { answers: Object.fromEntries(answers) };
}

function validateForm(schema, content) {
  if (!schema || schema.type !== 'object' || !content || Array.isArray(content) || typeof content !== 'object') throw Error('表单回答必须是 JSON 对象');
  for (const key of schema.required ?? []) if (!(key in content)) throw Error(`表单缺少字段：${key}`);
  for (const [key, value] of Object.entries(content)) {
    const field = schema.properties?.[key];
    if (!field) throw Error(`表单中不存在字段：${key}`);
    if (field.enum && !field.enum.includes(value)) throw Error(`字段 ${key} 的值不在选项内`);
    if (field.type === 'string' && typeof value !== 'string' || field.type === 'boolean' && typeof value !== 'boolean' || field.type === 'number' && typeof value !== 'number' || field.type === 'integer' && !Number.isInteger(value)) throw Error(`字段 ${key} 的类型不正确`);
    if (!['string', 'boolean', 'number', 'integer'].includes(field.type)) throw Error('此表单包含复杂字段，请在桌面处理');
  }
  return content;
}

export function buildResponse(request, reply) {
  const p = request.params ?? {}, action = reply.action, allow = action === '同意', deny = action === '拒绝';
  switch (request.method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval': {
      if (!allow && !deny) throw Error('审批请回复“同意 编号”或“拒绝 编号”');
      const decision = allow ? 'accept' : 'decline';
      if (p.availableDecisions && !p.availableDecisions.includes(decision)) throw Error('此请求不提供该决定，请在桌面处理');
      return { method: request.method.includes('commandExecution') ? 'thread-follower-command-approval-decision' : 'thread-follower-file-approval-decision', payload: { decision } };
    }
    case 'item/permissions/requestApproval':
      if (!allow && !deny) throw Error('权限请求请回复“同意 编号”或“拒绝 编号”');
      if (allow && (!p.permissions || typeof p.permissions !== 'object')) throw Error('无法识别权限范围，请在桌面处理');
      return { method: 'thread-follower-permissions-request-approval-response', payload: { response: { permissions: allow ? p.permissions : {}, scope: 'turn' } } };
    case 'item/tool/requestUserInput':
      if (action !== '回答' || !reply.answer) throw Error('请回复“回答 编号 你的答案”');
      return { method: 'thread-follower-submit-user-input', payload: { response: answersFor(p.questions ?? [], reply.answer) } };
    case 'desktop/asyncQuestion': {
      if (action !== '回答' || !reply.answer) throw Error('请回复“回答 编号 你的答案”');
      const result = answersFor(p.questions ?? [], reply.answer);
      const answer = result.answers[p.questionItemId].answers[0];
      return { method: 'thread-follower-steer-turn', payload: { input: [{ type: 'text', text: asyncAnswerText(request, answer), text_elements: [] }], attachments: [] } };
    }
    case 'mcpServer/elicitation/request': {
      if (p.mode === 'openai/userVerification') throw Error('身份验证请在桌面完成');
      let response;
      if (deny) response = { action: 'decline', content: null };
      else if (p.mode === 'url' && allow) response = { action: 'accept', content: null };
      else if (action === '回答') { let content; try { content = JSON.parse(reply.answer); } catch { throw Error('表单答案必须是合法 JSON'); } response = { action: 'accept', content: validateForm(p.requestedSchema, content) }; }
      else throw Error('请按表单要求回复；也可以在桌面处理');
      return { method: 'thread-follower-submit-mcp-server-elicitation-response', payload: { response } };
    }
    default: throw Error('此类请求暂不支持微信处理，请在桌面操作');
  }
}

export function splitMessage(text, maxBytes = 3500) {
  const chunks = []; let current = '', size = 0;
  for (const char of text) { const bytes = Buffer.byteLength(char); if (size + bytes > maxBytes) { chunks.push(current); current = ''; size = 0; } current += char; size += bytes; }
  if (current) chunks.push(current);
  return chunks.length === 1 ? chunks : chunks.map((part, i) => `(${i + 1}/${chunks.length})\n${part}`);
}
