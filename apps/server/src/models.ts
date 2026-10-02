import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile, lstat, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep, posix } from 'node:path';
import { inflateSync } from 'fflate';
import type { ModelInfo } from '@mofox/protocol';

const ZIP_LIMIT = 100 * 1024 * 1024;
const EXPANDED_LIMIT = 300 * 1024 * 1024;
const FILE_LIMIT = 4096;
const JSON_LIMIT = 8 * 1024 * 1024;
const MAX_TEXTURE_SIZE = 4096;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MIME: Record<string, string> = {
  '.json': 'application/json', '.moc3': 'application/octet-stream',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.txt': 'text/plain',
};
type AssetMap = Map<string, Buffer>;
type JsonObject = Record<string, unknown>;
interface StoredModel { info: ModelInfo; entry: string }

/** Reject filesystem and browser URL escapes before resolving a model asset. */
function assetPath(value: string): string {
  if (!value || value.length > 1024 || /[\x00-\x1f\x7f\\:#?%]/.test(value) || isAbsolute(value)) {
    throw new Error(`模型资源路径不安全：${value.slice(0, 120)}`);
  }
  const pieces = value.split('/');
  if (pieces.some((piece) => !piece || piece === '.' || piece === '..' || /[ .]$/.test(piece)
    || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(piece))) {
    throw new Error(`模型资源路径不安全：${value.slice(0, 120)}`);
  }
  return pieces.join('/');
}

function addAsset(assets: AssetMap, names: Set<string>, filename: string, contents: Buffer): void {
  const safe = assetPath(filename);
  const lower = safe.toLocaleLowerCase('en-US');
  if (names.has(lower)) throw new Error(`模型资源有重复文件名：${safe}`);
  if (!MIME[extname(safe).toLowerCase()]) throw new Error(`模型包不能包含脚本或不支持的文件：${safe}`);
  if (safe.split('/').some((part) => part.startsWith('.'))) throw new Error(`模型包不能包含隐藏文件：${safe}`);
  if (assets.size >= FILE_LIMIT) throw new Error(`模型资源数量超过 ${FILE_LIMIT}`);
  names.add(lower);
  assets.set(safe, contents);
}

function parseJson(contents: Buffer, filename: string): JsonObject {
  if (contents.length > JSON_LIMIT) throw new Error(`JSON 资源过大：${filename}`);
  let value: unknown;
  try { value = JSON.parse(contents.toString('utf8').replace(/^\uFEFF/, '')); }
  catch { throw new Error(`模型 JSON 无效：${filename}`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`模型 JSON 必须为对象：${filename}`);
  return value as JsonObject;
}

function checkTexture(contents: Buffer, filename: string): void {
  if (contents.length < 33 || contents.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
    || contents.readUInt32BE(8) !== 13 || contents.subarray(12, 16).toString('ascii') !== 'IHDR') {
    throw new Error(`Live2D 纹理必须为有效 PNG：${filename}`);
  }
  const width = contents.readUInt32BE(16);
  const height = contents.readUInt32BE(20);
  if (!width || !height || width > MAX_TEXTURE_SIZE || height > MAX_TEXTURE_SIZE) {
    throw new Error(`纹理 ${filename} 为 ${width}×${height}，最大允许 ${MAX_TEXTURE_SIZE}×${MAX_TEXTURE_SIZE}`);
  }
}

/** Read the central directory before inflation, rejecting ZIP bombs and links. */
function unpackZip(buffer: Buffer): AssetMap {
  if (!buffer.length || buffer.length > ZIP_LIMIT) throw new Error('模型 ZIP 最大为 100 MiB');
  let end = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65557); offset--) {
    if (buffer.readUInt32LE(offset) === 0x06054b50 && offset + 22 + buffer.readUInt16LE(offset + 20) === buffer.length) {
      end = offset; break;
    }
  }
  if (end < 0) throw new Error('无效的模型 ZIP');
  const count = buffer.readUInt16LE(end + 10);
  const directorySize = buffer.readUInt32LE(end + 12);
  const directoryOffset = buffer.readUInt32LE(end + 16);
  if (buffer.readUInt16LE(end + 4) || buffer.readUInt16LE(end + 6) || buffer.readUInt16LE(end + 8) !== count
    || count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff
    || count > FILE_LIMIT || directoryOffset + directorySize !== end) {
    throw new Error('不支持分卷、ZIP64 或超出限制的模型 ZIP');
  }
  const records: { name: string; method: number; size: number; start: number; compressed: number; crc: number }[] = [];
  const names = new Set<string>();
  let offset = directoryOffset;
  let total = 0;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('ZIP 目录损坏');
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressed = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const attributes = buffer.readUInt32LE(offset + 38);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (next > end || flags & 1 || ![0, 8].includes(method) || size === 0xffffffff || compressed === 0xffffffff
      || (attributes >>> 16 & 0xf000) === 0xa000) throw new Error('ZIP 包含加密文件、链接或不支持的压缩方式');
    const filenameBytes = buffer.subarray(offset + 46, offset + 46 + nameLength);
    const name = new TextDecoder('utf-8', { fatal: true }).decode(filenameBytes);
    const safe = assetPath(name.endsWith('/') ? name.slice(0, -1) : name);
    if (names.has(safe.toLowerCase())) throw new Error(`ZIP 包含重复路径：${safe}`);
    names.add(safe.toLowerCase());
    if (localOffset + 30 > directoryOffset || buffer.readUInt32LE(localOffset) !== 0x04034b50
      || buffer.readUInt16LE(localOffset + 8) !== method || buffer.readUInt16LE(localOffset + 6) !== flags) {
      throw new Error('ZIP 本地文件头损坏');
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const start = localOffset + 30 + localNameLength + buffer.readUInt16LE(localOffset + 28);
    if (start > directoryOffset || start + compressed > directoryOffset
      || !buffer.subarray(localOffset + 30, localOffset + 30 + localNameLength).equals(filenameBytes)) {
      throw new Error('ZIP 文件路径或长度不一致');
    }
    if (name.endsWith('/')) {
      if (size !== 0) throw new Error('ZIP 目录不能包含内容');
    } else {
      total += size;
      if (total > EXPANDED_LIMIT) throw new Error('模型 ZIP 解压后最大为 300 MiB');
      if (!MIME[extname(safe).toLowerCase()]) throw new Error(`模型包不能包含脚本或不支持的文件：${safe}`);
      records.push({ name: safe, method, size, start, compressed, crc: buffer.readUInt32LE(offset + 16) });
    }
    offset = next;
  }
  if (offset !== end) throw new Error('ZIP 目录长度不一致');
  const assets: AssetMap = new Map();
  const assetNames = new Set<string>();
  for (const record of records) {
    const compressed = buffer.subarray(record.start, record.start + record.compressed);
    // Giving fflate a fixed output buffer avoids allocating by untrusted deflate contents.
    const decoded = record.method === 0 ? compressed : inflateSync(compressed, { out: new Uint8Array(record.size) });
    if (decoded.length !== record.size || crc32(decoded) !== record.crc) throw new Error(`ZIP 文件校验失败：${record.name}`);
    addAsset(assets, assetNames, record.name, Buffer.from(decoded));
  }
  return assets;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let index = 0; index < 8; index++) crc = crc & 1 ? 0xedb88320 ^ crc >>> 1 : crc >>> 1;
  return crc >>> 0;
});
function crc32(contents: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of contents) crc = CRC_TABLE[(crc ^ byte) & 255]! ^ crc >>> 8;
  return (crc ^ 0xffffffff) >>> 0;
}

function validateAssets(assets: AssetMap): string {
  const entries = [...assets.keys()].filter((name) => name.toLowerCase().endsWith('.model3.json'));
  if (entries.length !== 1) throw new Error(`模型包必须只有一个 .model3.json 入口，当前有 ${entries.length} 个`);
  const entry = entries[0]!;
  const model = parseJson(assets.get(entry)!, entry);
  if (model.Version !== 3) throw new Error('只支持 Cubism 3/4/5 的 Version: 3 模型入口');
  const refs = model.FileReferences;
  if (!refs || typeof refs !== 'object' || Array.isArray(refs)) throw new Error('模型入口缺少 FileReferences');
  const references = refs as JsonObject;
  const directory = posix.dirname(entry);
  const referenced = (value: unknown, label: string): string => {
    if (typeof value !== 'string') throw new Error(`模型引用 ${label} 必须为相对文件路径`);
    const filename = posix.join(directory, assetPath(value));
    if (!assets.has(filename)) throw new Error(`模型缺少引用文件：${filename}`);
    return filename;
  };
  const moc = referenced(references.Moc, 'Moc');
  if (!moc.endsWith('.moc3') || assets.get(moc)!.subarray(0, 4).toString('ascii') !== 'MOC3') {
    throw new Error('模型 Moc 必须为有效 .moc3 文件');
  }
  if (!Array.isArray(references.Textures) || !references.Textures.length) throw new Error('模型缺少纹理 Textures');
  if (references.Textures.length > 32) throw new Error('单个模型最多允许 32 张纹理');
  for (const texture of references.Textures) {
    const filename = referenced(texture, 'Textures');
    checkTexture(assets.get(filename)!, filename);
  }
  for (const key of ['Physics', 'Pose', 'UserData', 'DisplayInfo']) {
    if (references[key] !== undefined) {
      const filename = referenced(references[key], key);
      parseJson(assets.get(filename)!, filename);
    }
  }
  // Some VTube Studio exports leave expressions/motions beside the model without
  // declaring them. Add these only to our imported copy, preserving original refs.
  const siblings = [...assets.keys()].filter((name) => posix.dirname(name) === directory).sort((a, b) => a.localeCompare(b));
  if (references.Expressions !== undefined && !Array.isArray(references.Expressions)) throw new Error('Expressions 必须为数组');
  const expressions = (references.Expressions ?? []) as unknown[];
  const expressionFiles = new Set<string>();
  for (const expression of expressions) {
    if (!expression || typeof expression !== 'object') throw new Error('Expression 必须为对象');
    const value = expression as JsonObject;
    const filename = referenced(value.File, 'Expressions.File');
    parseJson(assets.get(filename)!, filename);
    expressionFiles.add(filename);
  }
  for (const filename of siblings.filter((name) => name.endsWith('.exp3.json'))) {
    parseJson(assets.get(filename)!, filename);
    if (!expressionFiles.has(filename)) expressions.push({ Name: posix.basename(filename, '.exp3.json'), File: posix.basename(filename) });
  }
  if (expressions.length) references.Expressions = expressions;
  if (references.Motions !== undefined && (!references.Motions || typeof references.Motions !== 'object' || Array.isArray(references.Motions))) {
    throw new Error('Motions 必须为动作组对象');
  }
  const motions = (references.Motions ?? {}) as JsonObject;
  const motionFiles = new Set<string>();
  for (const [group, values] of Object.entries(motions)) {
    if (!Array.isArray(values)) throw new Error(`动作组 ${group} 必须为数组`);
    for (const motion of values) {
      if (!motion || typeof motion !== 'object') throw new Error('Motion 必须为对象');
      const value = motion as JsonObject;
      const filename = referenced(value.File, 'Motions.File');
      parseJson(assets.get(filename)!, filename);
      motionFiles.add(filename);
      if (value.Sound !== undefined) referenced(value.Sound, 'Motions.Sound');
    }
  }
  const other = (motions.Other ?? []) as unknown[];
  for (const filename of siblings.filter((name) => name.endsWith('.motion3.json'))) {
    parseJson(assets.get(filename)!, filename);
    if (!motionFiles.has(filename)) other.push({ File: posix.basename(filename) });
  }
  if (other.length) motions.Other = other;
  if (Object.keys(motions).length) references.Motions = motions;
  assets.set(entry, Buffer.from(JSON.stringify(model, null, 2) + '\n'));
  return entry;
}

export class ModelStore {
  readonly directory: string;
  constructor(dataRoot: string) { this.directory = resolve(dataRoot, 'live2d'); }

  async list(): Promise<ModelInfo[]> {
    await mkdir(this.directory, { recursive: true });
    const models: ModelInfo[] = [];
    for (const item of await readdir(this.directory, { withFileTypes: true })) {
      if (!item.isDirectory() || !ID_PATTERN.test(item.name)) continue;
      try {
        const record = JSON.parse(await readFile(join(this.directory, item.name, '.model-info.json'), 'utf8')) as StoredModel;
        if (record.info.id === item.name && typeof record.info.name === 'string' && typeof record.info.importedAt === 'string') {
          const entry = assetPath(record.entry);
          models.push({ ...record.info, entryUrl: this.url(item.name, entry) });
        }
      } catch { /* Interrupted/corrupt imports are never published. */ }
    }
    return models.sort((a, b) => b.importedAt.localeCompare(a.importedAt));
  }

  async importZip(buffer: Buffer, name: string): Promise<ModelInfo> {
    return this.persist(unpackZip(buffer), name.replace(/\.zip$/i, ''));
  }

  /** Host-only setup API: never expose arbitrary filesystem paths over HTTP. */
  async importDirectory(sourcePath: string): Promise<ModelInfo> {
    const source = resolve(sourcePath);
    if ((await lstat(source)).isSymbolicLink() || !(await lstat(source)).isDirectory()) throw new Error('模型来源必须为普通目录，不能为链接');
    const assets: AssetMap = new Map();
    const names = new Set<string>();
    let total = 0;
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const fullPath = join(directory, entry.name);
        const info = await lstat(fullPath);
        if (info.isSymbolicLink()) throw new Error(`模型目录不能包含链接：${entry.name}`);
        const assetName = relative(source, fullPath).split(sep).join('/');
        assetPath(assetName);
        if (info.isDirectory()) { await walk(fullPath); continue; }
        if (!info.isFile()) throw new Error(`模型目录包含特殊文件：${entry.name}`);
        total += info.size;
        if (total > EXPANDED_LIMIT) throw new Error('模型目录最大为 300 MiB');
        addAsset(assets, names, assetName, await readFile(fullPath));
      }
    };
    await walk(source);
    return this.persist(assets, basename(source));
  }

  async resource(id: string, relativePath: string): Promise<{ path: string; mime: string } | null> {
    if (!ID_PATTERN.test(id)) return null;
    let safe: string;
    try { safe = assetPath(relativePath); } catch { return null; }
    if (safe.split('/').some((part) => part.startsWith('.'))) return null;
    const mime = MIME[extname(safe).toLowerCase()];
    if (!mime) return null;
    const root = resolve(this.directory, id);
    const filename = resolve(root, ...safe.split('/'));
    try {
      let component = this.directory;
      for (const piece of [id, ...safe.split('/')]) {
        component = join(component, piece);
        if ((await lstat(component)).isSymbolicLink()) return null;
      }
      const rootReal = await realpath(root);
      const fileReal = await realpath(filename);
      const relation = relative(rootReal, fileReal);
      if (!relation || relation.startsWith('..' + sep) || relation === '..' || isAbsolute(relation) || !(await lstat(fileReal)).isFile()) return null;
      return { path: fileReal, mime };
    } catch { return null; }
  }

  private url(id: string, entry: string): string {
    return `/models/${id}/${entry.split('/').map(encodeURIComponent).join('/')}`;
  }

  private async persist(assets: AssetMap, name: string): Promise<ModelInfo> {
    const entry = validateAssets(assets);
    const id = randomUUID();
    const info: ModelInfo = { id, name: name.trim().slice(0, 120) || posix.basename(entry, '.model3.json'), entryUrl: this.url(id, entry), importedAt: new Date().toISOString() };
    await mkdir(this.directory, { recursive: true });
    const temporary = join(this.directory, `.import-${id}`);
    try {
      await mkdir(temporary);
      for (const [assetName, contents] of assets) {
        const target = join(temporary, ...assetName.split('/'));
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, contents, { flag: 'wx' });
      }
      await writeFile(join(temporary, '.model-info.json'), JSON.stringify({ info, entry } satisfies StoredModel), { flag: 'wx' });
      await rename(temporary, join(this.directory, id));
      return info;
    } catch (error) {
      // The target is always our generated UUID child beneath the model store.
      if (resolve(temporary).startsWith(this.directory + sep)) await rm(temporary, { recursive: true, force: true });
      throw error;
    }
  }
}
