import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
export const root = fileURLToPath(new URL('.', import.meta.url));
export const local = process.env.FIGMA_BRIDGE_STATE_DIR
  ? pathToFileURL(resolve(process.env.FIGMA_BRIDGE_STATE_DIR) + sep)
  : new URL('./.local/', import.meta.url);
export async function settings() {
  await mkdir(local, { recursive: true, mode: 0o700 });
  const path = new URL('settings.json', local);
  let value;
  try { value = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const initial = { port: 3848, token: randomBytes(32).toString('hex') };
    try { await writeFile(path, JSON.stringify(initial, null, 2), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    value = JSON.parse(await readFile(path, 'utf8'));
  }
  if (!value || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 || typeof value.token !== 'string' || !/^[a-f0-9]{64}$/.test(value.token)) {
    throw new Error('Invalid local settings: port must be 1–65535 and token must be 64 lowercase hexadecimal characters.');
  }
  if (value.pluginId !== undefined && (typeof value.pluginId !== 'string' || !/^\d+$/.test(value.pluginId))) throw new Error('pluginId must be the numeric string issued by Figma.');
  return value;
}
