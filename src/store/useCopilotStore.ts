import { create } from 'zustand';
import type { AppCapabilities, CopilotAnswer, QATurn } from '../../shared/types';

export type UiMode = 'full' | 'hint_only' | 'explain_simpler';

const MAX_HISTORY = 8;
const MAX_SUMMARY = 6000;

function guessRendererPlatform(): NodeJS.Platform {
  if (typeof navigator === 'undefined') return 'linux';
  if (/Windows/i.test(navigator.userAgent)) return 'win32';
  if (/Macintosh|Mac OS X/i.test(navigator.userAgent)) return 'darwin';
  return 'linux';
}

type State = {
  capabilities: AppCapabilities;
  interactionMode: boolean;
  sttRunning: boolean;
  liveLine: string;
  transcriptLog: string;
  manualNotes: string;
  conversationSummary: string;

  /** Currently displayed answer (answerHistory[effectiveIndex]). */
  answer: CopilotAnswer | null;
  /** All answers in arrival order, oldest → newest. Capped at MAX_HISTORY. */
  answerHistory: CopilotAnswer[];
  /** -1 = showing latest; ≥0 = user has stepped back to that slot. */
  historyIndex: number;

  /** Running chain of Q&A turns — gives the model context for follow-up questions. */
  conversationThread: QATurn[];

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

  /**
   * Push a new answer: always shows immediately and resets to latest.
   * Previous answers remain in history for back-navigation.
   */
  setAnswer: (a: CopilotAnswer) => void;

  /**
   * Navigate history. delta = -1 → older, +1 → newer.
   * Clamped; arriving at newest resets index to -1.
   */
  stepHistory: (delta: -1 | 1) => void;

  /** Append a resolved Q&A pair to the conversation thread (max 10 pairs). */
  appendToThread: (utterance: string, answer: CopilotAnswer) => void;

  setUiMode: (m: UiMode) => void;
  setGenerating: (v: boolean) => void;
  setError: (e: string | null) => void;
  setLastGenerateKey: (k: string) => void;
  rebuildSummary: () => void;
  clearSession: () => void;
};

export const useCopilotStore = create<State>((set) => ({
  capabilities: {
    aiReady: false,
    aiProvider: null,
    hasDeepgram: false,
    captureShieldDefault: true,
    platform: guessRendererPlatform(),
  },
  interactionMode: false,
  sttRunning: false,
  liveLine: '',
  transcriptLog: '',
  manualNotes: '',
  conversationSummary: '',
  answer: null,
  answerHistory: [],
  historyIndex: -1,
  conversationThread: [],
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

  setAnswer: (a) =>
    set((s) => {
      const history = [...s.answerHistory, a].slice(-MAX_HISTORY);
      return { answerHistory: history, historyIndex: -1, answer: a };
    }),

  stepHistory: (delta) =>
    set((s) => {
      if (s.answerHistory.length <= 1) return s;
      const last = s.answerHistory.length - 1;
      const current = s.historyIndex < 0 ? last : s.historyIndex;
      const next = Math.max(0, Math.min(last, current + delta));
      return {
        historyIndex: next === last ? -1 : next,
        answer: s.answerHistory[next],
      };
    }),

  appendToThread: (utterance, answer) =>
    set((s) => ({
      conversationThread: [
        ...s.conversationThread,
        { utterance: utterance.trim(), shortAnswer: answer.shortAnswer },
      ].slice(-10),
    })),

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
      answerHistory: [],
      historyIndex: -1,
      conversationThread: [],
      lastGenerateKey: '',
      error: null,
      generating: false,
    }),
}));
