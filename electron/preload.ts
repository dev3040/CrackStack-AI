import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type {
  AppCapabilities,
  ChatTurn,
  CopilotAnswer,
  GenerateInput,
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
    { ok: true; answer: CopilotAnswer } | { ok: false; error: string }
  >;
  aiChat: (
    payload: { messages: ChatTurn[] },
  ) => Promise<{ ok: true; text: string } | { ok: false; error: string }>;
  overlaySetInteraction: (enabled: boolean) => Promise<boolean>;
  overlayGetInteraction: () => Promise<boolean>;
  onTranscript: (cb: (ev: TranscriptEvent) => void) => () => void;
  onSttError: (cb: (message: string) => void) => () => void;
  onInteraction: (cb: (enabled: boolean) => void) => () => void;
  windowHide: () => Promise<{ ok: true }>;
  shieldGet: () => Promise<boolean>;
  shieldSet: (enabled: boolean) => Promise<boolean>;
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
  onInteraction: (cb) => {
    const handler = (_: IpcRendererEvent, enabled: boolean) => cb(enabled);
    ipcRenderer.on('copilot:interaction', handler);
    return () => ipcRenderer.removeListener('copilot:interaction', handler);
  },
  windowHide: () => ipcRenderer.invoke('window:hide'),
  shieldGet: () => ipcRenderer.invoke('shield:get'),
  shieldSet: (enabled) => ipcRenderer.invoke('shield:set', enabled),
};

contextBridge.exposeInMainWorld('copilotApi', api);
