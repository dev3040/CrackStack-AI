import { create } from 'zustand';
import type { AppCapabilities, CopilotAnswer, ResumeData, ResumeQuestion } from '../../shared/types';

export type UiMode = 'full' | 'hint_only' | 'explain_simpler';

type State = {
  capabilities: AppCapabilities;
  interactionMode: boolean;
  sttRunning: boolean;
  sttReconnecting: boolean;
  liveLine: string;
  transcriptLog: string;
  manualNotes: string;
  conversationSummary: string;
  answer: CopilotAnswer | null;
  uiMode: UiMode;
  generating: boolean;
  error: string | null;
  lastGenerateKey: string;
  lastTokensUsed: number | null;
  resumeText: string;
  resumeData: ResumeData | null;
  resumeQuestions: ResumeQuestion[];
  resumeParsing: boolean;
  setCapabilities: (c: State['capabilities']) => void;
  setInteractionMode: (v: boolean) => void;
  setSttRunning: (v: boolean) => void;
  setSttReconnecting: (v: boolean) => void;
  setLiveLine: (v: string) => void;
  appendFinalTranscript: (text: string) => void;
  setManualNotes: (v: string) => void;
  setAnswer: (a: CopilotAnswer | null) => void;
  setUiMode: (m: UiMode) => void;
  setGenerating: (v: boolean) => void;
  setError: (e: string | null) => void;
  setLastGenerateKey: (k: string) => void;
  setLastTokensUsed: (n: number | null) => void;
  rebuildSummary: () => void;
  setResumeText: (v: string) => void;
  setResumeData: (d: ResumeData | null) => void;
  setResumeQuestions: (q: ResumeQuestion[]) => void;
  setResumeParsing: (v: boolean) => void;
  clearResume: () => void;
  /** Reset live STT text, transcript log, summary, manual notes, and structured answer */
  clearSession: () => void;
};

const MAX_SUMMARY = 6000;

function guessRendererPlatform(): NodeJS.Platform {
  if (typeof navigator === 'undefined') return 'linux';
  if (/Windows/i.test(navigator.userAgent)) return 'win32';
  if (/Macintosh|Mac OS X/i.test(navigator.userAgent)) return 'darwin';
  return 'linux';
}

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
  sttReconnecting: false,
  liveLine: '',
  transcriptLog: '',
  manualNotes: '',
  conversationSummary: '',
  answer: null,
  uiMode: 'full',
  generating: false,
  error: null,
  lastGenerateKey: '',
  lastTokensUsed: null,
  resumeText: '',
  resumeData: null,
  resumeQuestions: [],
  resumeParsing: false,
  setCapabilities: (capabilities) => set({ capabilities }),
  setInteractionMode: (interactionMode) => set({ interactionMode }),
  setSttRunning: (sttRunning) => set({ sttRunning }),
  setSttReconnecting: (sttReconnecting) => set({ sttReconnecting }),
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
  setLastTokensUsed: (lastTokensUsed) => set({ lastTokensUsed }),
  rebuildSummary: () =>
    set((s) => {
      const merged = `${s.transcriptLog}\n${s.manualNotes}`.trim();
      const tail =
        merged.length > MAX_SUMMARY
          ? merged.slice(merged.length - MAX_SUMMARY)
          : merged;
      return { conversationSummary: tail };
    }),
  setResumeText: (resumeText) => set({ resumeText }),
  setResumeData: (resumeData) => set({ resumeData }),
  setResumeQuestions: (resumeQuestions) => set({ resumeQuestions }),
  setResumeParsing: (resumeParsing) => set({ resumeParsing }),
  clearResume: () =>
    set({ resumeText: '', resumeData: null, resumeQuestions: [], resumeParsing: false }),
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
      lastTokensUsed: null,
    }),
}));
