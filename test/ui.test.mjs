import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

async function pluginUi() {
  const html = await readFile(new URL('../plugin/ui.html', import.meta.url), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, 'plugin UI script exists');
  const elements = new Map();
  const document = { getElementById(id) {
    if (!elements.has(id)) elements.set(id, { textContent: '', style: {}, onclick: null });
    return elements.get(id);
  } };
  const parentMessages = [];
  const parent = { postMessage(message) { parentMessages.push(message); } };
  const top = {};
  const window = {};
  const sockets = [];
  class WebSocketStub {
    static OPEN = 1;
    constructor(url) { this.url = url; this.readyState = WebSocketStub.OPEN; this.sent = []; sockets.push(this); }
    send(message) { this.sent.push(JSON.parse(message)); }
  }
  runInNewContext(script.replace('__BRIDGE_CONFIG__', JSON.stringify({ port: 3848, token: 'synthetic-test-token' })),
    { document, parent, top, window, WebSocket: WebSocketStub, clearTimeout, setTimeout });
  assert.equal(parentMessages[0]?.pluginMessage?.type, 'ready');
  return { window, parent, top, elements, sockets };
}

test('Figma top-frame info connects while unrelated messages are ignored', async () => {
  const { window, parent, top, elements, sockets } = await pluginUi();
  const info = { pluginMessage: { type: 'info', documentId: 'synthetic-document', name: 'Scratch', page: 'Page 1' } };
  window.onmessage({ source: top, origin: 'https://unrelated.example', data: info });
  window.onmessage({ source: {}, origin: 'https://www.figma.com', data: info });
  assert.equal(sockets.length, 0);
  assert.equal(elements.get('file')?.textContent ?? '', '');
  window.onmessage({ source: top, origin: 'https://www.figma.com', data: info });
  assert.equal(elements.get('file').textContent, 'Scratch');
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].url, 'ws://localhost:3848/plugin');

  const legacy = await pluginUi();
  legacy.window.onmessage({ source: legacy.parent, origin: 'null', data: info });
  assert.equal(legacy.sockets.length, 1);
});

async function connectedUi() {
  const ui = await pluginUi();
  ui.window.onmessage({ source: ui.parent, data: { pluginMessage: {
    type: 'info', documentId: 'synthetic-document', name: 'Scratch', page: 'Page 1'
  } } });
  const socket = ui.sockets[0];
  socket.onmessage({ data: JSON.stringify({ type: 'connected' }) });
  return { ...ui, socket, result(id, result) {
    ui.window.onmessage({ source: ui.parent, data: { pluginMessage: { type: 'result', id, result } } });
  } };
}

test('read failure shows its cause separately from connection status and clears after success', async () => {
  const ui = await connectedUi();
  ui.socket.onmessage({ data: JSON.stringify({ id: 'read-1', action: 'document' }) });
  const error = 'Unable to establish connection to Figma after 10 seconds. <not HTML>';
  ui.result('read-1', { error });
  assert.match(ui.elements.get('label').textContent, /Connected/);
  assert.equal(ui.elements.get('dot').style.background, '#1a7f37');
  const failure = ui.elements.get('command-error');
  assert.ok(failure, 'error details are visible');
  assert.equal(failure.hidden, false);
  assert.ok(failure.textContent.includes(error), 'preserve exact error as literal text');
  assert.doesNotMatch(failure.textContent, /inspect the canvas/i);
  assert.equal(ui.elements.get('help').hidden, true);
  assert.deepEqual(ui.socket.sent.at(-1), { id: 'read-1', result: { error } });
  ui.socket.onmessage({ data: JSON.stringify({ id: 'read-2', action: 'document' }) });
  ui.result('read-2', { tree: { id: 'scratch-page', type: 'PAGE' } });
  assert.equal(failure.hidden, true);
  assert.equal(failure.textContent, '');
  assert.equal(ui.elements.get('help').hidden, false);
});

test('failed writes and unknown commands retain the canvas inspection warning', async () => {
  for (const action of ['create_nodes', 'update_nodes', 'delete_nodes', 'move_to_page', 'prototype', undefined]) {
    const ui = await connectedUi();
    ui.socket.onmessage({ data: JSON.stringify({ id: 'write', action }) });
    ui.result('write', { error: 'Synthetic failure' });
    const failure = ui.elements.get('command-error');
    assert.ok(failure, 'error details are visible');
    assert.match(failure.textContent, /Synthetic failure/);
    assert.match(failure.textContent, /inspect the canvas/i);
    assert.equal(ui.socket.sent.length, 1, 'do not replay the failed command');
  }
});

test('a partial result keeps the canvas warning even for an unexpected read result', async () => {
  const ui = await connectedUi();
  ui.socket.onmessage({ data: JSON.stringify({ id: 'partial', action: 'document' }) });
  ui.result('partial', { error: 'Synthetic partial error', partial: true, possiblyChangedNodeIds: ['scratch-node'] });
  const failure = ui.elements.get('command-error');
  assert.ok(failure, 'error details are visible');
  assert.match(failure.textContent, /inspect the canvas/i);
});
