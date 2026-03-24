import { create } from 'zustand';
import type { AppCapabilities, CopilotAnswer } from '../../shared/types';

export type UiMode = 'full' | 'hint_only' | 'explain_simpler';

type State = {
  capabilities: AppCapabilities;
  interactionMode: boolean;
  sttRunning: boolean;
  liveLine: string;
  transcriptLog: string;
  manualNotes: string;
  conversationSummary: string;
  answer: CopilotAnswer | null;
  uiMode: UiMode;
  generating: boolean;
  error: string | null;
  lastGenerateKey: string;
  setCapabilities: (c: State['capabilities']) => void;
  setInteractionMode: (v: boolean) => void;
  setSttRunning: (v: boolean) => void;
  setLiveLine: (v: string) => void;
  appendFinalTranscript: (text: string) => void;
  setManualNotes: (v: string) => void;
  setAnswer: (a: CopilotAnswer | null) => void;
  setUiMode: (m: UiMode) => void;
  setGenerating: (v: boolean) => void;
  setError: (e: string | null) => void;
  setLastGenerateKey: (k: string) => void;
  rebuildSummary: () => void;
  /** Reset live STT text, transcript log, summary, manual notes, and structured answer */
  clearSession: () => void;
};

const MAX_SUMMARY = 6000;

export const useCopilotStore = create<State>((set) => ({
  capabilities: {
    aiReady: false,
    aiProvider: null,
    hasDeepgram: false,
    captureShieldDefault: true,
  },
  interactionMode: false,
  sttRunning: false,
  liveLine: '',
  transcriptLog: '',
  manualNotes: '',
  conversationSummary: '',
  answer: null,
  uiMode: 'full',
  generating: false,
  error: null,
  lastGenerateKey: '',
  setCapabilities: (capabilities) => set({ capabilities }),
  setInteractionMode: (interactionMode) => set({ interactionMode }),
  setSttRunning: (sttRunning) => set({ sttRunning }),
  setLiveLine: (liveLine) => set({ liveLine }),
  appendFinalTranscript: (text) =>
    set((s) => {
      const line = text.trim();
      if (!line) return s;
      const next = `${s.transcriptLog}\n${line}`.trim();
      return { transcriptLog: next, liveLine: '' };
    }),
  setManualNotes: (manualNotes) => set({ manualNotes }),
  setAnswer: (answer) => set({ answer }),
  setUiMode: (uiMode) => set({ uiMode }),
  setGenerating: (generating) => set({ generating }),
  setError: (error) => set({ error }),
  setLastGenerateKey: (lastGenerateKey) => set({ lastGenerateKey }),
  rebuildSummary: () =>
    set((s) => {
      const merged = `${s.transcriptLog}\n${s.manualNotes}`.trim();
      const tail =
        merged.length > MAX_SUMMARY
          ? merged.slice(merged.length - MAX_SUMMARY)
          : merged;
      return { conversationSummary: tail };
    }),
  clearSession: () =>
    set({
      liveLine: '',
      transcriptLog: '',
      conversationSummary: '',
      manualNotes: '',
      answer: null,
      lastGenerateKey: '',
      error: null,
      generating: false,
    }),
}));
