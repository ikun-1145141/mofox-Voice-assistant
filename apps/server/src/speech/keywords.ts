import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pinyin } from 'pinyin-pro';

/**
 * The Chinese WenetSpeech KWS model uses ppinyin, not hanzi or numbered tones.
 * Match sherpa's to_initials/to_finals_tone(strict=False): y/w remain initials,
 * and the rest of a tone-marked syllable is retained without ü/iou restoration.
 * Official conversion: sherpa-onnx/python/sherpa_onnx/utils.py::text2token.
 */
export async function writeKeywords(wakePhrase: string, tokensPath: string, outputPath: string): Promise<void> {
  if (!/^[\p{Script=Han}]{2,20}$/u.test(wakePhrase)) {
    throw new Error('自动唤醒词仅支持 2–20 个连续汉字；中英文、空格或特殊读音请配置外部 keywords 文件');
  }
  const syllables = pinyin(wakePhrase, { type: 'array', toneType: 'symbol', toneSandhi: false, v: false });
  const encoded: string[] = [];
  for (const syllable of syllables) {
    const match = /^(zh|ch|sh|[bpmfdtnlgkhjqxrzcsyw])?(.*)$/u.exec(syllable.normalize('NFC'));
    if (!match || !match[2]) throw new Error(`无法生成唤醒词拼音：${wakePhrase}；请使用外部 keywords 文件`);
    if (match[1]) encoded.push(match[1]);
    encoded.push(match[2]);
  }
  const info = await stat(tokensPath);
  if (!info.isFile() || info.size > 1024 * 1024) throw new Error('KWS tokens 文件无效或过大');
  const tokens = new Set<string>();
  for (const line of (await readFile(tokensPath, 'utf8')).replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^(\S+)\s+\d+\s*$/u.exec(line);
    if (!match) throw new Error('KWS tokens 文件格式无效，预期每行为“token id”');
    tokens.add(match[1]!);
  }
  const unknown = [...new Set(encoded.filter((token) => !tokens.has(token)))];
  if (unknown.length) throw new Error(`唤醒词拼音不在此 KWS 模型的 tokens 中：${unknown.join('、')}；请检查模型或配置外部 keywords 文件`);
  const output = resolve(outputPath);
  const temporary = `${output}.${randomUUID()}.tmp`;
  await mkdir(dirname(output), { recursive: true });
  try {
    await writeFile(temporary, `${encoded.join(' ')} @${wakePhrase}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, output);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
