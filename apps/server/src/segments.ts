import { randomUUID } from 'node:crypto';
import type { SpeechSegment } from '@mofox/protocol';

export function speechSegments(content: string, turnId: string, startIndex = 0): SpeechSegment[] {
  const output: SpeechSegment[] = [];
  let emotion: string | null = null; let motion: string | null = null; let waitBeforeMs = 0;
  const chunks = content.split(/(\[(?:wait\s*:\s*[\d.]+|emotion\s*:\s*[\w-]+|motion\s*:\s*[\w-]+|\/emotion|\/motion)\])/gi);
  for (const chunk of chunks) {
    if (/^\[wait:/i.test(chunk)) { waitBeforeMs = Math.min(5000, Math.max(0, Number(chunk.match(/[\d.]+/)?.[0] ?? 0) * 1000)); continue; }
    if (/^\[emotion:/i.test(chunk)) { emotion = chunk.slice(chunk.indexOf(':') + 1, -1).trim().toLowerCase(); continue; }
    if (/^\[motion:/i.test(chunk)) { motion = chunk.slice(chunk.indexOf(':') + 1, -1).trim().toLowerCase(); continue; }
    if (chunk === '[/emotion]') { emotion = null; continue; }
    if (chunk === '[/motion]') { motion = null; continue; }
    const clean = chunk.replace(/\[\/?(?:wait|emotion|motion)[^\]\n]*\]?/gi, '').replace(/```[\s\S]*?```/g, '（代码内容请查看文字）').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[*#`_]/g, '').trim();
    for (const sentence of clean.match(/[^。！？!?\n]+(?:[。！？!?]+|$)/g) ?? []) {
      if (!/[\p{L}\p{N}]/u.test(sentence)) continue;
      for (let i = 0; i < sentence.length; i += 300) {
        const text = sentence.slice(i, i + 300).trim();
        output.push({ turnId, segmentId: randomUUID(), index: startIndex + output.length, text, emotion, motion, waitBeforeMs });
        waitBeforeMs = 0;
        if (output.length >= 40) return output;
      }
    }
  }
  return output;
}
export function displayText(content: string): string { return content.replace(/\[\/?(?:wait|emotion|motion)[^\]\n]*\]?/gi, '').trim(); }
