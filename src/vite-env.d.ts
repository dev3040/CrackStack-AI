/// <reference types="vite/client" />

import type {
  AppCapabilities,
  ChatTurn,
  CopilotAnswer,
  GenerateInput,
  TranscriptEvent,
} from '../shared/types';

type AiResult =
  | { ok: true; answer: CopilotAnswer }
  | { ok: false; error: string };

declare global {
  interface Window {
    copilotApi: {
      capabilities: () => Promise<AppCapabilities>;
      sttStart: (
        opts: { sampleRate: number },
      ) => Promise<{ ok: true } | { ok: false; error: string }>;
      sttStop: () => Promise<{ ok: true }>;
      sttSendPcm: (pcm: ArrayBuffer) => void;
      aiGenerate: (input: GenerateInput) => Promise<AiResult>;
      aiChat: (payload: { messages: ChatTurn[] }) => Promise<ChatResult>;
      overlaySetInteraction: (enabled: boolean) => Promise<boolean>;
      overlayGetInteraction: () => Promise<boolean>;
      onTranscript: (cb: (ev: TranscriptEvent) => void) => () => void;
      onSttError: (cb: (message: string) => void) => () => void;
      onInteraction: (cb: (enabled: boolean) => void) => () => void;
      windowHide: () => Promise<{ ok: true }>;
      shieldGet: () => Promise<boolean>;
      shieldSet: (enabled: boolean) => Promise<boolean>;
    };
  }
}

export {};
