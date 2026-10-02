import { z } from 'zod';

export const PROTOCOL_VERSION = 1 as const;
export type AssistantState = 'idle' | 'listening' | 'recognizing' | 'thinking' | 'synthesizing' | 'speaking' | 'error';
export interface ServiceHealth { ready: boolean; detail: string }
export interface ModelInfo { id: string; name: string; entryUrl: string; importedAt: string }
export interface VoiceProfile { id: string; name: string; refAudioPath: string; promptText: string; promptLang: string; textLang: string; speed: number }
export interface ModelMapping { mouthParameter: string; emotions: Record<string, string>; motions: Record<string, string> }
export interface PublicSettings {
  assistantName: string;
  wakePhrase: string;
  tts: { baseUrl: string; enabled: boolean; timeoutMs: number; voice: VoiceProfile };
  speech: { enabled: boolean; senseVoiceModel: string; tokens: string; kwsEncoder: string; kwsDecoder: string; kwsJoiner: string; kwsTokens: string; keywordsFile: string; silenceMs: number; maxUtteranceMs: number };
  live2d: { defaultModelId: string; coreReady: boolean; mapping: ModelMapping };
}
export interface StatusResponse {
  name: string; version: string; secure: boolean; authenticated: boolean; admin: boolean;
  bridge: ServiceHealth; tts: ServiceHealth; speech: ServiceHealth; kws: ServiceHealth;
  live2dCore: ServiceHealth; models: number;
}
export interface SessionReady { sessionId: string; clientId: string; admin: boolean; settings: PublicSettings; models: ModelInfo[] }
export interface SpeechSegment { turnId: string; segmentId: string; index: number; text: string; emotion: string | null; motion: string | null; waitBeforeMs: number }
export type ServerEvent =
  | { type: 'session.ready'; data: SessionReady }
  | { type: 'status.changed'; data: StatusResponse }
  | { type: 'state.changed'; state: AssistantState; turnId?: string; detail?: string }
  | { type: 'wake.detected'; phrase: string }
  | { type: 'asr.result'; text: string }
  | { type: 'bot.message'; turnId: string; messageId: string; text: string }
  | { type: 'performance.segment'; segment: SpeechSegment }
  | { type: 'audio.ready'; segment: SpeechSegment; url: string }
  | { type: 'turn.completed'; turnId: string }
  | { type: 'turn.failed'; turnId: string; message: string }
  | { type: 'error'; code: string; message: string };

const id = z.string().min(1).max(128);
export const clientEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text.submit'), text: z.string().trim().min(1).max(4000), submissionId: id }),
  z.object({ type: z.literal('turn.cancel') }),
  z.object({ type: z.literal('listen.start'), mode: z.enum(['manual', 'kws']) }),
  z.object({ type: z.literal('listen.stop') }),
  z.object({ type: z.literal('audio.start'), sampleRate: z.literal(16000), format: z.literal('pcm_s16le') }),
  z.object({ type: z.literal('audio.end') }),
  z.object({ type: z.literal('playback.started'), segmentId: id }),
  z.object({ type: z.literal('playback.finished'), segmentId: id }),
  z.object({ type: z.literal('playback.stopped') }),
  z.object({ type: z.literal('session.new') })
]);
export type ClientEvent = z.infer<typeof clientEventSchema>;

export const bridgeEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('bridge.ready'), version: z.literal(1), botName: z.string().max(128), capabilities: z.array(z.string()).max(20) }),
  z.object({ type: z.literal('chat.accepted'), turnId: id }),
  z.object({ type: z.literal('bot.message'), sessionId: id, turnId: id, messageId: id, text: z.string().max(32000) }),
  z.object({ type: z.literal('turn.completed'), sessionId: id, turnId: id }),
  z.object({ type: z.literal('turn.failed'), sessionId: id, turnId: id, message: z.string().max(2000) }),
  z.object({ type: z.literal('bridge.error'), message: z.string().max(2000) })
]);
export type BridgeEvent = z.infer<typeof bridgeEventSchema>;
export interface ChatSubmit { type: 'chat.submit'; version: 1; sessionId: string; userId: string; turnId: string; messageId: string; text: string; nickname: string }
export interface ChatCancel { type: 'chat.cancel'; sessionId: string; turnId: string }
