import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
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

export type CopilotApi = {
  capabilities: () => Promise<AppCapabilities>;
  sttStart: (opts: { sampleRate: number }) => Promise<
    { ok: true } | { ok: false; error: string }
  >;
  sttStop: () => Promise<{ ok: true }>;
  sttSendPcm: (pcm: ArrayBuffer) => void;
  aiGenerate: (
    input: GenerateInput,
  ) => Promise<
    | { ok: true; answer: CopilotAnswer; cached: boolean }
    | { ok: false; error: string }
  >;
  aiChat: (
    payload: { messages: ChatTurn[] },
  ) => Promise<{ ok: true; text: string } | { ok: false; error: string }>;
  overlaySetInteraction: (enabled: boolean) => Promise<boolean>;
  overlayGetInteraction: () => Promise<boolean>;
  overlaySetOpacity: (opacity: number) => Promise<{ ok: true; opacity: number }>;
  overlayGetOpacity: () => Promise<number>;
  onTranscript: (cb: (ev: TranscriptEvent) => void) => () => void;
  onSttError: (cb: (message: string) => void) => () => void;
  onSttReconnecting: (cb: (attempt: number) => void) => () => void;
  onSttClosed: (cb: () => void) => () => void;
  onInteraction: (cb: (enabled: boolean) => void) => () => void;
  /** Fired when a global mode shortcut (Alt+1/2/3) is pressed. */
  onMode: (cb: (mode: GenerateMode) => void) => () => void;
  windowHide: () => Promise<{ ok: true }>;
  shieldGet: () => Promise<boolean>;
  shieldSet: (enabled: boolean) => Promise<boolean>;
  resumeParse: (
    text: string,
  ) => Promise<{ ok: true; data: ResumeData } | { ok: false; error: string }>;
  resumeQuestions: (
    data: ResumeData,
  ) => Promise<{ ok: true; questions: ResumeQuestion[] } | { ok: false; error: string }>;
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

const api: CopilotApi = {
  capabilities: () => ipcRenderer.invoke('app:capabilities'),
  sttStart: (opts) => ipcRenderer.invoke('stt:start', opts),
  sttStop: () => ipcRenderer.invoke('stt:stop'),
  sttSendPcm: (pcm) => ipcRenderer.send('stt:pcm', new Uint8Array(pcm)),
  aiGenerate: (input) => ipcRenderer.invoke('ai:generate', input),
  aiChat: (payload) => ipcRenderer.invoke('ai:chat', payload),
  overlaySetInteraction: (enabled) =>
    ipcRenderer.invoke('overlay:setInteraction', enabled),
  overlayGetInteraction: () => ipcRenderer.invoke('overlay:getInteraction'),
  overlaySetOpacity: (opacity) =>
    ipcRenderer.invoke('overlay:setOpacity', opacity),
  overlayGetOpacity: () => ipcRenderer.invoke('overlay:getOpacity'),
  onTranscript: (cb) => {
    const handler = (_: IpcRendererEvent, ev: TranscriptEvent) => cb(ev);
    ipcRenderer.on('copilot:transcript', handler);
    return () => ipcRenderer.removeListener('copilot:transcript', handler);
  },
  onSttError: (cb) => {
    const handler = (_: IpcRendererEvent, msg: string) => cb(msg);
    ipcRenderer.on('copilot:stt-error', handler);
    return () => ipcRenderer.removeListener('copilot:stt-error', handler);
  },
  onSttReconnecting: (cb) => {
    const handler = (_: IpcRendererEvent, attempt: number) => cb(attempt);
    ipcRenderer.on('copilot:stt-reconnecting', handler);
    return () => ipcRenderer.removeListener('copilot:stt-reconnecting', handler);
  },
  onSttClosed: (cb) => {
    const handler = (_: IpcRendererEvent) => cb();
    ipcRenderer.on('copilot:stt-closed', handler);
    return () => ipcRenderer.removeListener('copilot:stt-closed', handler);
  },
  onInteraction: (cb) => {
    const handler = (_: IpcRendererEvent, enabled: boolean) => cb(enabled);
    ipcRenderer.on('copilot:interaction', handler);
    return () => ipcRenderer.removeListener('copilot:interaction', handler);
  },
  onMode: (cb) => {
    const handler = (_: IpcRendererEvent, mode: GenerateMode) => cb(mode);
    ipcRenderer.on('copilot:mode', handler);
    return () => ipcRenderer.removeListener('copilot:mode', handler);
  },
  windowHide: () => ipcRenderer.invoke('window:hide'),
  shieldGet: () => ipcRenderer.invoke('shield:get'),
  shieldSet: (enabled) => ipcRenderer.invoke('shield:set', enabled),
  resumeParse: (text) => ipcRenderer.invoke('resume:parse', text),
  resumeQuestions: (data) => ipcRenderer.invoke('resume:questions', data),
  resumeInterviewAnswer: (payload) =>
    ipcRenderer.invoke('resume:interview-answer', payload),
  resumeUploadFile: (payload) => ipcRenderer.invoke('resume:upload-file', payload),
  analyzeScreen: (context) => ipcRenderer.invoke('ai:analyze-screen', context),
};

contextBridge.exposeInMainWorld('copilotApi', api);
