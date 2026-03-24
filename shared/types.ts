export type QuestionKind =
  | 'DSA'
  | 'SYSTEM_DESIGN'
  | 'HR'
  | 'CODING'
  | 'DEBUGGING'
  | 'UNKNOWN';

export type CopilotAnswer = {
  kind: QuestionKind;
  languageGuess?: string;
  shortAnswer: string;
  detailedExplanation: string;
  codeSnippet?: string;
  timeComplexity?: string;
  spaceComplexity?: string;
  edgeCases: string[];
  followUpHints: string[];
};

export type GenerateMode = 'full' | 'hint_only' | 'explain_simpler';

export type GenerateInput = {
  latestUtterance: string;
  conversationSummary: string;
  manualContext?: string;
  mode: GenerateMode;
};

/** Deepgram (or other STT) live partial/final payloads */
export type TranscriptEvent = {
  text: string;
  isFinal: boolean;
  speechFinal: boolean;
};

export type AiProvider = 'groq' | 'openrouter' | 'openai' | null;

export type AppCapabilities = {
  aiReady: boolean;
  aiProvider: AiProvider;
  hasDeepgram: boolean;
  /** Default “hide from screen capture” when no localStorage override exists */
  captureShieldDefault: boolean;
  /** From Electron `process.platform` (e.g. win32 uses system-audio loopback for Meet mode). */
  platform: NodeJS.Platform;
};

/** Freeform chat with the model (renderer keeps history). */
export type ChatTurn = { role: 'user' | 'assistant'; content: string };
