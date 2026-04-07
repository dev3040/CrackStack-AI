/// <reference types="vite/client" />

import type {
  AppCapabilities,
  ChatTurn,
  CopilotAnswer,
  GenerateInput,
  GenerateMode,
  ResumeData,
  ResumeInterviewAnswer,
  ResumeQuestion,
  TranscriptEvent,
} from '../shared/types';

type AiResult =
  | { ok: true; answer: CopilotAnswer; cached: boolean }
  | { ok: false; error: string };

type ChatResult = { ok: true; text: string } | { ok: false; error: string };

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
      overlaySetOpacity: (
        opacity: number,
      ) => Promise<{ ok: true; opacity: number }>;
      overlayGetOpacity: () => Promise<number>;
      onTranscript: (cb: (ev: TranscriptEvent) => void) => () => void;
      onSttError: (cb: (message: string) => void) => () => void;
      onSttReconnecting: (cb: (attempt: number) => void) => () => void;
      onSttClosed: (cb: () => void) => () => void;
      onInteraction: (cb: (enabled: boolean) => void) => () => void;
      onMode: (cb: (mode: GenerateMode) => void) => () => void;
      windowHide: () => Promise<{ ok: true }>;
      shieldGet: () => Promise<boolean>;
      shieldSet: (enabled: boolean) => Promise<boolean>;
      resumeParse: (
        text: string,
      ) => Promise<{ ok: true; data: ResumeData } | { ok: false; error: string }>;
      resumeQuestions: (
        data: ResumeData,
      ) => Promise<
        { ok: true; questions: ResumeQuestion[] } | { ok: false; error: string }
      >;
      resumeInterviewAnswer: (payload: {
        question: string;
        resumeData: ResumeData;
      }) => Promise<
        { ok: true; result: ResumeInterviewAnswer } | { ok: false; error: string }
      >;
      resumeUploadFile: (payload: {
        base64: string;
        mimeType: string;
        fileName: string;
      }) => Promise<{ ok: true; text: string } | { ok: false; error: string }>;
      analyzeScreen: (
        context?: string,
      ) => Promise<
        | { ok: true; answer: CopilotAnswer }
        | { ok: false; error: string }
      >;
    };
  }
}

export {};
