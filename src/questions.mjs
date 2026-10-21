const TAG = '<send_user_message_question_reply>', END = '</send_user_message_question_reply>';
const LEAVES = new Set(['id', 'turnId', 'status', 'type', 'kind', 'value', 'phase', 'turnStartedAtMs', 'durationMs']);
const HEAVY = new Set(['text', 'output', 'arguments', 'tool_response', 'params', 'reasoning', 'textDelta', 'delta']);

// Retain question cards and final assistant text; discard reasoning and tool output.
export function projectHistory(value, key = '') {
  if (key === 'questions') return structuredClone(value);
  if (key === 'error') return typeof value === 'string' ? value : value?.message ? { message: String(value.message) } : null;
  if (key === 'text') return typeof value === 'string' ? value : '';
  if (key === 'content' || key === 'input') return Array.isArray(value) ? value.filter(x => x?.type === 'text' && typeof x.text === 'string' && x.text.trim().startsWith(TAG)).map(x => ({ type: 'text', text: x.text })) : [];
  if (value === null || typeof value !== 'object') return LEAVES.has(key) ? value : null;
  if (Array.isArray(value)) return value.map(x => projectHistory(x));
  const result = Object.create(null);
  for (const [name, child] of Object.entries(value)) {
    if (name === 'text' && value.type === 'agentMessage' && value.phase === 'final_answer') { result.text = child; continue; }
    if (name === 'error') { result.error = projectHistory(child, name); continue; }
    if (['__proto__', 'constructor', 'prototype'].includes(name) || HEAVY.has(name)) continue;
    if (child && typeof child === 'object' || LEAVES.has(name)) result[name] = projectHistory(child, name);
  }
  return result;
}

export function historyPatchRelevant(path) {
  if (path.includes('questions')) return true;
  if (path.includes('text') || path.includes('error')) return true;
  if ((path.includes('content') || path.includes('input')) && !['content', 'input'].includes(path.at(-1))) return false;
  if (path.some(k => HEAVY.has(k)) && !path.includes('content') && !path.includes('input')) return false;
  return true;
}

function answeredIds(item) {
  if (!['userMessage', 'steeringUserMessage'].includes(item.type) || item.type === 'steeringUserMessage' && item.status !== 'accepted') return [];
  const texts = item.content ?? item.input ?? [];
  if (texts.length !== 1 || texts[0]?.type !== 'text') return [];
  if (typeof texts[0].text !== 'string') return [];
  const text = texts[0].text.trim(); if (!text.startsWith(TAG) || !text.endsWith(END)) return [];
  try { const data = JSON.parse(text.slice(TAG.length, -END.length)); return (Array.isArray(data) ? data : [data]).map(x => x.questionItemId); } catch { return []; }
}

export function pendingRequests(state) {
  const turns = new Map();
  function visit(node, turn) {
    if (!node || typeof node !== 'object') return;
    if (typeof node.turnId === 'string' && node.status) { turn = turns.get(node.turnId) ?? { id: node.turnId, status: node.status, cards: new Map(), answers: new Set() }; turns.set(turn.id, turn); }
    if (turn) {
      if (node.type === 'agentMessage' && Array.isArray(node.questions) && node.questions.length) turn.cards.set(node.id, node.questions);
      for (const id of answeredIds(node)) turn.answers.add(id);
    }
    for (const [key, child] of Object.entries(node)) if (!['requests', 'questions', 'content', 'input'].includes(key)) visit(child, turn);
  }
  visit({ turns: state.turns, turnHistory: state.turnHistory }, null);
  const requests = [...state.requests];
  for (const turn of turns.values()) {
    if (turn.status !== 'inProgress') continue;
    for (const [itemId, cards] of turn.cards) for (const [index, card] of cards.entries()) {
      const questionItemId = JSON.stringify(['request_user_input_async', itemId, index]);
      if (turn.answers.has(questionItemId)) continue;
      requests.push({ id: `async:${turn.id}:${questionItemId}`, method: 'desktop/asyncQuestion', params: { turnId: turn.id, questionItemId, questions: [{ id: questionItemId, question: card.title ?? card.question, options: (card.options ?? []).map(o => typeof o === 'string' ? { label: o } : o) }] } });
    }
  }
  return requests;
}

export function asyncAnswerText(request, answer) {
  return `${TAG}\n${JSON.stringify([{ questionItemId: request.params.questionItemId, question: request.params.questions[0].question, answer }])}\n${END}`;
}
