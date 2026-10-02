import type { PublicSettings, ServiceHealth } from '@mofox/protocol';

export type SpeechConfig = PublicSettings['speech'];
export type ListenMode = 'manual' | 'kws';
export interface SpeechCallbacks {
  onWake(phrase: string): void;
  onListening(): void;
  onRecognizing?(): void;
  onResult(text: string): void;
  onError(message: string): void;
  onEnded(): void;
}
export interface SpeechHealth { asr: ServiceHealth; kws: ServiceHealth }
export interface SpeechSession {
  start(mode: ListenMode): void;
  /** Normalized mono samples in [-1, 1], already resampled to 16 kHz. */
  push(samples: Float32Array): void;
  finish(): void;
  stop(): void;
}
export type WorkerRequest =
  | { type: 'kws.start'; sessionId: string; generation: number }
  | { type: 'kws.audio'; sessionId: string; generation: number; samples: Float32Array }
  | { type: 'kws.stop'; sessionId: string }
  | { type: 'asr.decode'; sessionId: string; utteranceId: number; samples: Float32Array };
export type WorkerResponse =
  | { type: 'health'; health: SpeechHealth }
  | { type: 'wake'; sessionId: string; generation: number; phrase: string }
  | { type: 'kws.processed'; sessionId: string; generation: number }
  | { type: 'asr.result'; sessionId: string; utteranceId: number; text: string }
  | { type: 'error'; sessionId: string; utteranceId?: number; generation?: number; message: string };
