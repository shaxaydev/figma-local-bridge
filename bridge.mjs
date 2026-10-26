import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { settings } from './settings.mjs';

export async function createBridge({ port, token, timeoutMs = 45000 }) {
  let plugin = null;
  let pluginInfo = null;
  let busy = false;
  let closing;
  const pending = new Map();
  function close() {
    return closing ??= (async () => {
      rejectPending('Bridge shutting down');
      for (const ws of wss.clients) ws.terminate();
      await new Promise(resolve => wss.close(resolve));
      await new Promise(resolve => server.close(resolve));
    })();
  }
  function authorized(value) {
    const a = Buffer.from(String(value ?? ''));
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  function rejectPending(message) {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error(message)); }
    pending.clear();
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    const reply = (status, value) => { res.statusCode = status; res.end(JSON.stringify(value)); };
    // Browser pages must not be able to call the command endpoint, even on loopback.
    if (req.headers.origin || !authorized(req.headers.authorization?.replace(/^Bearer /, ''))) {
      reply(401, { error: 'Unauthorized' }); return;
    }
    if (req.method === 'GET' && req.url === '/status') {
      reply(200, { service: 'figma-local-bridge', version: 1, connected: Boolean(plugin), busy, plugin: pluginInfo }); return;
    }
    if (req.method === 'POST' && req.url === '/shutdown') {
      if (busy) { reply(409, { error: 'Wait for the current command before stopping the bridge.' }); return; }
      res.once('finish', () => { void close().catch(console.error); });
      reply(200, { stopped: true }); return;
    }
    if (req.method !== 'POST' || req.url !== '/command') { reply(404, { error: 'Not found' }); return; }
    if (!plugin || plugin.readyState !== WebSocket.OPEN) { reply(409, { error: 'Open the Figma Local Bridge development plugin in the Figma file first.' }); return; }
    if (busy) { reply(409, { error: 'Figma is executing another command. Wait for it to finish.' }); return; }
    const targetPlugin = plugin;
    let ownsCommand = false;
    try {
      const parts = []; let size = 0;
      for await (const part of req) {
        size += part.length;
        if (size > 16 * 1024 * 1024) { reply(413, { error: 'Command exceeds 16 MB.' }); return; }
        parts.push(part);
      }
      const command = JSON.parse(Buffer.concat(parts).toString('utf8'));
      if (!command || typeof command.action !== 'string' || !command.targetDocumentId) {
        reply(400, { error: 'action and targetDocumentId are required. Call document first.' }); return;
      }
      if (busy) { reply(409, { error: 'Figma is busy.' }); return; }
      if (plugin !== targetPlugin || targetPlugin.readyState !== WebSocket.OPEN) {
        reply(409, { error: 'Figma connection changed while receiving the command. Read the document again.' }); return;
      }
      const id = randomUUID();
      busy = true;
      ownsCommand = true;
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (!pending.delete(id)) return;
          // Timeout does not imply cancellation. Disconnect so a late mutation cannot be mistaken for a retry.
          targetPlugin.close(1011, 'Command timeout; inspect canvas before retry');
          reject(new Error('Command timed out; it may have changed the canvas. Inspect before retrying.'));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer, socket:targetPlugin });
        const rejectSend = error => {
          if (!pending.delete(id)) return;
          clearTimeout(timer);
          reject(error);
        };
        try {
          targetPlugin.send(JSON.stringify({ ...command, id }), error => { if (error) rejectSend(error); });
        } catch (error) { rejectSend(error); }
      });
      reply(200, result);
    } catch (error) { reply(500, { error: error.message }); }
    finally { if (ownsCommand) busy = false; }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 20 * 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const origin = req.headers.origin;
    if (req.url !== '/plugin' || (origin && origin !== 'null' && !/^https:\/\/([a-z0-9-]+\.)?figma\.com$/.test(origin))) {
      socket.destroy(); return;
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
  });
  wss.on('connection', ws => {
    let authenticated = false;
    const deadline = setTimeout(() => ws.close(1008, 'Authentication required'), 5000);
    ws.on('error', () => {});
    ws.on('message', raw => {
      try {
        const message = JSON.parse(raw.toString());
        if (!authenticated) {
          if (message.type !== 'hello' || !authorized(message.token) || typeof message.documentId !== 'string') {
            ws.close(1008, 'Invalid pairing'); return;
          }
          if (plugin && plugin !== ws) { ws.close(1008, 'Another Figma plugin is connected. Close it first.'); return; }
          authenticated = true; clearTimeout(deadline); plugin = ws;
          pluginInfo = { documentId: message.documentId, name: String(message.name), page: String(message.page) };
          ws.send(JSON.stringify({ type: 'connected' })); return;
        }
        const item = pending.get(message.id);
        if (item && ws === plugin && ws === item.socket) { clearTimeout(item.timer); pending.delete(message.id); item.resolve(message.result); }
      } catch { ws.close(1008, 'Invalid message'); }
    });
    ws.on('close', () => {
      clearTimeout(deadline);
      if (plugin === ws) { plugin = null; pluginInfo = null; rejectPending('Figma disconnected. Inspect canvas before retrying a write.'); }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return {
    port: server.address().port,
    close
  };
}

if (process.argv.includes('--daemon')) {
  try {
    const bridge = await createBridge(await settings());
    process.on('SIGTERM', async () => { await bridge.close(); process.exit(0); });
    process.on('SIGINT', async () => { await bridge.close(); process.exit(0); });
  } catch (error) {
    if (error.code !== 'EADDRINUSE') console.error(error);
    process.exit(error.code === 'EADDRINUSE' ? 0 : 1);
  }
}
