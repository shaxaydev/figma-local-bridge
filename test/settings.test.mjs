import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run=promisify(execFile);
const moduleUrl=new URL('../settings.mjs',import.meta.url).href;
async function temporary(t) {
  const path=await mkdtemp(join(tmpdir(),'figma-local-bridge-settings-'));
  t.after(()=>rm(path,{recursive:true,force:true}));return path;
}
async function load(path) {
  const {stdout}=await run(process.execPath,['--input-type=module','-e',`const {settings}=await import(${JSON.stringify(moduleUrl)});console.log(JSON.stringify(await settings()));`],{env:{...process.env,FIGMA_BRIDGE_STATE_DIR:path}});
  return JSON.parse(stdout);
}
test('fresh installations create distinct private tokens and preserve settings',async t=>{
  const first=await temporary(t),second=await temporary(t);
  const a=await load(first),b=await load(second);
  assert.equal(a.port,3848);assert.match(a.token,/^[a-f0-9]{64}$/);assert.notEqual(a.token,b.token);
  assert.deepEqual(await load(first),a);
  if(process.platform!=='win32')assert.equal((await stat(join(first,'settings.json'))).mode&0o777,0o600);
});
test('custom port and plugin ID persist; invalid settings fail closed',async t=>{
  const path=await temporary(t);const config={...await load(path),port:4567,pluginId:'1234567890'};
  await writeFile(join(path,'settings.json'),JSON.stringify(config));assert.deepEqual(await load(path),config);
  await writeFile(join(path,'settings.json'),JSON.stringify({...config,port:0}));
  await assert.rejects(load(path),/Invalid local settings/);
  await writeFile(join(path,'settings.json'),JSON.stringify({...config,token:'weak'}));
  await assert.rejects(load(path),/Invalid local settings/);
  await writeFile(join(path,'settings.json'),JSON.stringify({...config,pluginId:123}));
  await assert.rejects(load(path),/pluginId must/);
  assert.ok((await readFile(join(path,'settings.json'),'utf8')).includes('pluginId'));
});

test('pairing tokens must be strings rather than coercible JSON values',async t=>{
  const path=await temporary(t);
  for (const token of [['a'.repeat(64)],null,{}]) {
    await writeFile(join(path,'settings.json'),JSON.stringify({port:3848,token}));
    await assert.rejects(load(path),/Invalid local settings/);
  }
});
