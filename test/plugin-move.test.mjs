import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';

const source = await readFile(new URL('../plugin/code.ts', import.meta.url), 'utf8');
const code = transformSync(source, { loader: 'ts', target: 'es2018' }).code;

function frame(id, x = 0, y = 0, children = []) {
  return {
    id, type: 'FRAME', name: id, removed: false, parent: null, children,
    relativeTransform: [[1, 0, x], [0, 1, y]],
    get absoluteTransform() {
      const parent = this.parent?.absoluteTransform ?? [[1, 0, 0], [0, 1, 0]];
      return [[1, 0, parent[0][2] + this.relativeTransform[0][2]],
        [0, 1, parent[1][2] + this.relativeTransform[1][2]]];
    }
  };
}

// Execute the actual plugin with a synthetic, translation-only Figma node tree.
async function sandbox(children) {
  const messages = [], appendCalls = [], nodes = new Map();
  let undoCommits = 0;
  const page = {
    id: '0:1', type: 'PAGE', name: 'Scratch page', children, selection: [],
    appendChild(node) {
      appendCalls.push(node.id);
      node.parent.children = node.parent.children.filter(child => child !== node);
      this.children.push(node);
      node.parent = this;
    }
  };
  const root = { id: '0:0', type: 'DOCUMENT', name: 'Scratch', children: [page] };
  function attach(node, parent) {
    node.parent = parent;
    nodes.set(node.id, node);
    for (const child of node.children) attach(child, node);
  }
  for (const node of children) attach(node, page);
  const figma = {
    root, currentPage: page,
    ui: { postMessage(message) { messages.push(JSON.parse(JSON.stringify(message))); } },
    showUI() {}, commitUndo() { undoCommits++; },
    async getNodeByIdAsync(id) { return nodes.get(id) ?? null; }
  };
  runInNewContext(code, { figma, __html__: '' });
  await figma.ui.onmessage({ type: 'ready' });
  const documentId = messages.pop().documentId;
  async function move(nodeIds) {
    await figma.ui.onmessage({ type: 'command', command: {
      id: 'synthetic-move', action: 'move_to_page', targetDocumentId: documentId, nodeIds
    } });
    const reply = messages.pop();
    assert.equal(reply?.id, 'synthetic-move');
    return reply.result;
  }
  return { page, appendCalls, move, get undoCommits() { return undoCommits; } };
}

for (const nodeIds of [['A', 'C'], ['C', 'A']]) {
  test(`move rejects selected ancestor and grandchild before any append (${nodeIds.join(', ')})`, async () => {
    const c = frame('C');
    const b = frame('B', 0, 0, [c]);
    const a = frame('A', 0, 0, [b]);
    const s = await sandbox([a]);

    const result = await s.move(nodeIds);

    assert.deepEqual(s.appendCalls, [], 'invalid ancestor combinations must be rejected before any reparenting');
    assert.match(result.error, /ancestor|parent/i);
    assert.equal(a.parent, s.page);
    assert.equal(b.parent, a);
    assert.equal(c.parent, b);
    assert.deepEqual(s.page.children, [a]);
    assert.equal(s.undoCommits, 0);
  });
}

test('moving sibling frames to the page preserves their absolute positions', async () => {
  const first = frame('first', 10, 20);
  const second = frame('second', -5, 35);
  const container = frame('container', 100, 200, [first, second]);
  const s = await sandbox([container]);

  const result = await s.move(['first', 'second']);

  assert.equal(result.error, undefined);
  assert.deepEqual(result.movedNodeIds, ['first', 'second']);
  assert.equal(first.parent, s.page);
  assert.equal(second.parent, s.page);
  assert.deepEqual(first.absoluteTransform, [[1, 0, 110], [0, 1, 220]]);
  assert.deepEqual(second.absoluteTransform, [[1, 0, 95], [0, 1, 235]]);
  assert.deepEqual(container.children, []);
  assert.equal(s.undoCommits, 1);
});
