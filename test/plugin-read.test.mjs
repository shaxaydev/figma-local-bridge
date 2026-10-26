import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';

const source = await readFile(new URL('../plugin/code.ts', import.meta.url), 'utf8');
const code = transformSync(source, { loader: 'ts', target: 'es2018' }).code;
const connectionError = 'Unable to establish connection to Figma after 10 seconds. Please check your internet connection.';

// Real plugin code, with synthetic node handles and Figma's JSON-message boundary.
async function sandbox({ mixedText = false } = {}) {
  const mixed = Symbol('mixed');
  const messages = [], lookupCalls = [], selectedPages = [], exportCalls = [];
  const child = {
    id: 'I12:34;56:78', type: 'TEXT', name: 'Instance child', removed: false,
    x: 0, y: 0, width: 80, height: 20, characters: 'Synthetic text',
    fontName: mixedText ? mixed : { family: 'Inter', style: 'Regular' },
    fontSize: mixedText ? mixed : 14,
    fills: mixedText ? mixed : [],
    async exportAsync(options) {
      exportCalls.push({ node: this, options });
      return new Uint8Array([137, 80, 78, 71]);
    }
  };
  const instance = { id: '12:34', type: 'INSTANCE', name: 'Instance', removed: false, children: [child] };
  const ancestor = { id: '10:1', type: 'FRAME', name: 'Ancestor', removed: false, children: [instance] };
  const page = { id: '0:1', type: 'PAGE', name: 'Page 1', children: [ancestor], selection: [] };
  const otherPage = { id: '0:2', type: 'PAGE', name: 'Page 2', children: [], selection: [] };
  const root = { id: '0:0', type: 'DOCUMENT', name: 'Scratch', children: [page, otherPage] };
  const asyncNodes = new Map([[ancestor.id, ancestor]]);
  const failingIds = new Set([child.id, otherPage.id]);
  function assertJsonSafe(value) {
    if (typeof value === 'symbol') throw new Error('in postMessage: Cannot unwrap symbol');
    if (value && typeof value === 'object') for (const item of Object.values(value)) assertJsonSafe(item);
  }
  const figma = {
    mixed, root, currentPage: page,
    ui: { postMessage(message) {
      assertJsonSafe(message);
      messages.push(JSON.parse(JSON.stringify(message)));
    } },
    showUI() {}, commitUndo() {},
    base64Encode: bytes => Buffer.from(bytes).toString('base64'),
    async getNodeByIdAsync(id) {
      lookupCalls.push(id);
      if (failingIds.has(id)) throw new Error(connectionError);
      return asyncNodes.get(id) ?? null;
    },
    async setCurrentPageAsync(target) {
      selectedPages.push(target);
      figma.currentPage = target;
    }
  };
  runInNewContext(code, { figma, __html__: '' });
  await figma.ui.onmessage({ type: 'ready' });
  const documentId = messages.pop().documentId;
  let sequence = 0;
  async function command(action, args = {}) {
    const id = `synthetic-command-${++sequence}`;
    await figma.ui.onmessage({ type: 'command', command: { id, action, targetDocumentId: documentId, ...args } });
    const reply = messages.pop();
    assert.equal(reply?.id, id, 'each command receives a matching result');
    return reply.result;
  }
  return { command, figma, mixed, child, instance, ancestor, otherPage, lookupCalls, selectedPages, exportCalls, asyncNodes, failingIds };
}

test('document selects an existing root page handle without an async id lookup', async () => {
  const s = await sandbox();
  const result = await s.command('document', { pageId: s.otherPage.id, depth: 0 });
  assert.equal(result.error, undefined);
  assert.equal(result.currentPageId, s.otherPage.id);
  assert.deepEqual(s.selectedPages, [s.otherPage]);
  assert.deepEqual(s.lookupCalls, []);
});

test('a described instance child can be read and exported using its remembered exact handle', async () => {
  const s = await sandbox();
  const ancestor = await s.command('document', { nodeId: s.ancestor.id, depth: 3 });
  assert.equal(ancestor.error, undefined);
  const childId = ancestor.tree.children[0].children[0].id;
  assert.equal(childId, s.child.id);

  const child = await s.command('document', { nodeId: childId, depth: 0 });
  assert.equal(child.error, undefined);
  assert.equal(child.tree.id, childId);
  const exported = await s.command('export_node', { nodeId: childId });
  assert.equal(exported.error, undefined);
  assert.equal(exported.nodeId, childId);
  assert.equal(exported.base64, 'iVBORw==');
  assert.equal(s.exportCalls[0].node, s.child);
  assert.deepEqual(s.lookupCalls, [s.ancestor.id]);
});

test('mixed text properties are explicit JSON markers at the postMessage boundary', async () => {
  const s = await sandbox({ mixedText: true });
  const result = await s.command('document', { depth: 4 });
  assert.equal(result.error, undefined);
  const text = result.tree.children[0].children[0].children[0];
  assert.equal(text.fontName, 'mixed');
  assert.equal(text.fontSize, 'mixed');
  assert.equal(Object.hasOwn(text, 'fills'), false);
  assert.equal(s.child.fontName, s.mixed, 'reading must preserve the original mixed text state');
  assert.equal(s.child.fontSize, s.mixed);
});

test('removed remembered handles are rejected and unknown ids retain async fallback', async () => {
  const s = await sandbox();
  assert.equal((await s.command('document', { nodeId: s.ancestor.id, depth: 3 })).error, undefined);
  s.child.removed = true;
  s.instance.children = [];
  s.failingIds.delete(s.child.id);
  const removed = await s.command('document', { nodeId: s.child.id, depth: 0 });
  assert.match(removed.error, /Scene node not found/);

  const unseen = { id: '90:1', type: 'RECTANGLE', name: 'Unseen node', removed: false, x: 1, y: 2, width: 3, height: 4 };
  s.asyncNodes.set(unseen.id, unseen);
  const result = await s.command('document', { nodeId: unseen.id, depth: 0 });
  assert.equal(result.error, undefined);
  assert.equal(result.tree.id, unseen.id);
  assert.ok(s.lookupCalls.includes(unseen.id), 'unremembered ids still use the supported async resolver');
});
