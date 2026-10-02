import { cp, mkdir, access, readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import path from 'node:path';
import { ROOT, loadConfig } from '../apps/server/src/config.js';

const { values } = parseArgs({ options: { neo: { type: 'string', default: 'G:\\Neo-MoFox' }, update: { type: 'boolean', default: false } } });
const neo = path.resolve(values.neo!);
await access(path.join(neo, 'pyproject.toml'));
const destination = path.join(neo, 'plugins/voice_web_assistant');
let installed = false;
try { await access(destination); installed = true; } catch {}
if (installed && !values.update) throw new Error('插件目录已存在；确认更新时运行 npm run plugin:install -- --update。');
const config = await loadConfig();
await cp(path.join(ROOT, 'integrations/neo_mofox/voice_web_assistant'), destination, { recursive: true, force: !!values.update, filter: source => !source.includes('__pycache__') && !source.endsWith('.pyc') });
const configFile = path.join(neo, 'config/plugins/voice_web_assistant/config.toml');
await mkdir(path.dirname(configFile), { recursive: true });
let previous = '';
try { previous = await readFile(configFile, 'utf8'); } catch {}
if (previous) await writeFile(`${configFile}.backup-${Date.now()}`, previous);
const quoted = (value: string) => JSON.stringify(value);
await writeFile(configFile, `[plugin]\nenabled = true\n\n[bridge]\nurl = ${quoted(`ws://127.0.0.1:${config.bridge.port}/bridge`)}\ntoken = ${quoted(config.bridge.token)}\nreconnect_seconds = 3.0\nturn_timeout_seconds = 180.0\nbot_name = ""\n`, { mode: 0o600 });
console.log(`插件已安装：${destination}\n配置已写入：${configFile}\n请在本地网页服务启动后重启 Neo-MoFox，使其加载新插件。`);
