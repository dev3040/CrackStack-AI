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

/** One resolved Q&A exchange — fed back as context for follow-up questions. */
export type QATurn = {
  utterance: string;
  shortAnswer: string;
};

/** Candidate's resume + target job description — used to personalize answers (Parakeet-style). */
export type CandidateContext = {
  resume?: string;
  jobDescription?: string;
};

export type GenerateInput = {
  latestUtterance: string;
  conversationSummary: string;
  /** Previous Q&A pairs so the model can build on its own prior answers. */
  conversationThread?: QATurn[];
  manualContext?: string;
  mode: GenerateMode;
  candidateContext?: CandidateContext;
};

/** Which physical source produced a transcript when the session streams separate channels. */
export type TranscriptSource = 'mic' | 'tab';

/** Deepgram (or other STT) live partial/final payloads */
export type TranscriptEvent = {
  text: string;
  isFinal: boolean;
  speechFinal: boolean;
  /** Only set for multichannel sessions: 'mic' = your voice, 'tab' = interviewer / remote audio. */
  source?: TranscriptSource;
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
