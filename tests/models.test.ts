import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { zipSync } from 'fflate';
import { ModelStore } from '../apps/server/src/models.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZioAAAAASUVORK5CYII=', 'base64');
const entry = { Version: 3, FileReferences: { Moc: '角色.moc3', Textures: ['textures/texture.png'] } };
function assets(model = entry): Record<string, Uint8Array> {
  return {
    '模型/角色.model3.json': Buffer.from(JSON.stringify(model)),
    '模型/角色.moc3': Buffer.from('MOC3-test-fixture'),
    '模型/textures/texture.png': png,
    '模型/脸红.exp3.json': Buffer.from('{"Type":"Live2D Expression","Parameters":[]}'),
    '模型/生气.motion3.json': Buffer.from('{"Version":3,"Curves":[]}'),
  };
}
async function fixture(t: { after(fn: () => Promise<void>): void }): Promise<{ root: string; store: ModelStore }> {
  const root = await mkdtemp(join(tmpdir(), 'mofox-model-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, store: new ModelStore(root) };
}

test('ZIP imports nested Unicode assets and publishes expressions and motions', async (t) => {
  const { store } = await fixture(t);
  const model = await store.importZip(Buffer.from(zipSync(assets())), '蓝音.zip');
  assert.equal(model.name, '蓝音');
  assert.match(model.entryUrl, /\/models\/[0-9a-f-]+\/%E6%A8%A1%E5%9E%8B\//);
  assert.deepEqual((await store.list()).map((item) => item.id), [model.id]);
  const resource = await store.resource(model.id, '模型/角色.model3.json');
  assert.ok(resource);
  const imported = JSON.parse(await readFile(resource.path, 'utf8'));
  assert.deepEqual(imported.FileReferences.Expressions, [{ Name: '脸红', File: '脸红.exp3.json' }]);
  assert.deepEqual(imported.FileReferences.Motions.Other, [{ File: '生气.motion3.json' }]);
  assert.equal((await store.resource(model.id, '模型/textures/texture.png'))?.mime, 'image/png');
  assert.equal(await store.resource(model.id, '../private.txt'), null);
  assert.equal(await store.resource(model.id, '模型/../角色.moc3'), null);
  assert.equal(await store.resource(model.id, '.model-info.json'), null);
  assert.equal(await store.resource(model.id, 'C:/private.txt'), null);
});

test('host directory import copies assets without changing original model entry', async (t) => {
  const { root, store } = await fixture(t);
  const source = join(root, 'source');
  for (const [filename, contents] of Object.entries(assets())) {
    const target = join(source, ...filename.split('/'));
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, contents);
  }
  const original = await readFile(join(source, '模型', '角色.model3.json'), 'utf8');
  const model = await store.importDirectory(source);
  assert.equal(model.name, 'source');
  assert.equal(await readFile(join(source, '模型', '角色.model3.json'), 'utf8'), original);
  assert.ok(await store.resource(model.id, '模型/角色.model3.json'));
});

test('rejects missing references, external resources and ambiguous model entry', async (t) => {
  const { store } = await fixture(t);
  const missing = assets();
  delete missing['模型/角色.moc3'];
  await assert.rejects(store.importZip(Buffer.from(zipSync(missing)), 'x'), /缺少引用/);
  const external = assets({ Version: 3, FileReferences: { Moc: 'https://evil.test/model.moc3', Textures: ['textures/texture.png'] } });
  await assert.rejects(store.importZip(Buffer.from(zipSync(external)), 'x'), /路径不安全/);
  const multiple = assets();
  multiple['second.model3.json'] = Buffer.from(JSON.stringify(entry));
  await assert.rejects(store.importZip(Buffer.from(zipSync(multiple)), 'x'), /只有一个/);
  assert.equal((await store.list()).length, 0);
});

test('rejects ZIP traversal, scripts, Unix symlinks and advertised expansion bombs', async (t) => {
  const { store } = await fixture(t);
  await assert.rejects(store.importZip(Buffer.from(zipSync({ ...assets(), '../outside.txt': Buffer.from('x') })), 'x'), /路径不安全/);
  await assert.rejects(store.importZip(Buffer.from(zipSync({ ...assets(), 'script.js': Buffer.from('alert(1)') })), 'x'), /脚本/);
  const symlink = Buffer.from(zipSync(assets()));
  const directory = symlink.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.ok(directory > 0);
  symlink.writeUInt32LE(0xa1ff0000, directory + 38);
  await assert.rejects(store.importZip(symlink, 'x'), /链接/);
  const bomb = Buffer.from(zipSync(assets()));
  bomb.writeUInt32LE(301 * 1024 * 1024, directory + 24);
  await assert.rejects(store.importZip(bomb, 'x'), /300 MiB/);
});

test('rejects PNG textures above 4096 pixels and corrupt ZIP content', async (t) => {
  const { store } = await fixture(t);
  const oversized = assets();
  const texture = Buffer.from(png);
  texture.writeUInt32BE(8192, 16);
  oversized['模型/textures/texture.png'] = texture;
  await assert.rejects(store.importZip(Buffer.from(zipSync(oversized)), 'x'), /8192×1/);
  const corrupt = Buffer.from(zipSync(assets(), { level: 0 }));
  const nameLength = corrupt.readUInt16LE(26);
  const extraLength = corrupt.readUInt16LE(28);
  corrupt[30 + nameLength + extraLength]! ^= 1;
  await assert.rejects(store.importZip(corrupt, 'x'), /校验失败/);
});
