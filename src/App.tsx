import { useCallback, useEffect, useRef, useState } from 'react';
import {
  startMeetMixedPcmCapture,
  startMicPcmCapture,
} from './audio/capture';
import { AnswerCard } from './components/AnswerCard';
import { ChatDock } from './components/ChatDock';
import { TitleBar } from './components/TitleBar';
import { ToolsDrawer } from './components/ToolsDrawer';
import { useCopilotStore } from './store/useCopilotStore';
import type { ChatTurn, GenerateMode } from '../shared/types';

const api = window.copilotApi;

const CAPTURE_SHIELD_STORAGE = 'copilot.captureShield';
const MEET_TAB_AUDIO_STORAGE = 'copilot.includeMeetTabAudio';
const STT_SYSTEM_ONLY_STORAGE = 'copilot.sttSystemAudioOnly';
const OVERLAY_OPACITY_STORAGE = 'copilot.overlayOpacity';
const MIC_DEVICE_STORAGE = 'copilot.micDeviceId';
const MIC_GAIN_STORAGE = 'copilot.micGain';
const TAB_GAIN_STORAGE = 'copilot.tabGain';
const HEADSET_MODE_STORAGE = 'copilot.headsetAudioMode';

/**
 * After each STT final, wait this long with no further finals before calling the model.
 * Back-to-back questions (short pause between) merge into one prompt instead of answering the first alone.
 */
const STT_SILENCE_BEFORE_GENERATE_MS = 1500;

/** Merge successive Deepgram finals into one “current turn” string without naive duplication. */
function mergeQuestionBurst(prev: string, next: string): string {
  const a = prev.trim();
  const b = next.trim();
  if (!a) return b;
  if (!b) return a;
  if (a === b) return a;
  if (b.startsWith(a)) return b;
  if (a.startsWith(b)) return a;
  return `${a} ${b}`;
}

function readGainStorage(key: string, fallback: number): number {
  if (typeof localStorage === 'undefined') return fallback;
  const v = parseFloat(localStorage.getItem(key) ?? '');
  if (!Number.isFinite(v)) return fallback;
  return Math.min(4, Math.max(0.25, v));
}

function clampUiOpacity(v: number): number {
  if (!Number.isFinite(v)) return 1;
  return Math.min(1, Math.max(0.15, v));
}

function readStoredOpacity(): number {
  if (typeof localStorage === 'undefined') return 1;
  return clampUiOpacity(
    parseFloat(localStorage.getItem(OVERLAY_OPACITY_STORAGE) ?? '1'),
  );
}

function formatAnswerForClipboard(a: {
  shortAnswer: string;
  detailedExplanation: string;
  codeSnippet?: string;
  followUpHints: string[];
  edgeCases: string[];
  timeComplexity?: string;
  spaceComplexity?: string;
}): string {
  const parts = [
    a.shortAnswer,
    '',
    a.detailedExplanation,
    a.codeSnippet ? `\nCode:\n${a.codeSnippet}` : '',
    a.timeComplexity || a.spaceComplexity
      ? `\nComplexity: ${a.timeComplexity ?? '?'} time / ${a.spaceComplexity ?? '?'} space`
      : '',
    a.edgeCases.length ? `\nEdge cases:\n- ${a.edgeCases.join('\n- ')}` : '',
    a.followUpHints.length ? `\nFollow-ups:\n- ${a.followUpHints.join('\n- ')}` : '',
  ];
  return parts.join('\n').trim();
}

export default function App() {
  const stopCaptureRef = useRef<(() => Promise<void>) | null>(null);
  const silenceGenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const questionBurstRef = useRef<string>('');
  const finalFallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  const [toolsOpen, setToolsOpen] = useState(false);
  const [captureShield, setCaptureShield] = useState(true);
  const [includeMeetTabAudio, setIncludeMeetTabAudio] = useState(
    () =>
      typeof localStorage !== 'undefined' &&
      localStorage.getItem(MEET_TAB_AUDIO_STORAGE) === '1',
  );
  /** With Meet/system capture: default on so STT uses playback/loopback only, not your headset mic. */
  const [sttSystemAudioOnly, setSttSystemAudioOnly] = useState(() => {
    if (typeof localStorage === 'undefined') return true;
    const v = localStorage.getItem(STT_SYSTEM_ONLY_STORAGE);
    if (v === '0') return false;
    if (v === '1') return true;
    return true;
  });
  const [audioHint, setAudioHint] = useState<string | null>(null);
  const [micDevices, setMicDevices] = useState<MediaDeviceInfo[]>([]);
  const [micDeviceId, setMicDeviceId] = useState(
    () =>
      typeof localStorage !== 'undefined'
        ? (localStorage.getItem(MIC_DEVICE_STORAGE) ?? '')
        : '',
  );
  const [micGain, setMicGain] = useState(() =>
    readGainStorage(MIC_GAIN_STORAGE, 1),
  );
  const [tabGain, setTabGain] = useState(() =>
    readGainStorage(TAB_GAIN_STORAGE, 1),
  );
  const [headsetMode, setHeadsetMode] = useState(
    () =>
      typeof localStorage === 'undefined' ||
      localStorage.getItem(HEADSET_MODE_STORAGE) !== '0',
  );
  const [deviceChangeHint, setDeviceChangeHint] = useState(false);

  const [chatMessages, setChatMessages] = useState<ChatTurn[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatBusy, setChatBusy] = useState(false);
  const [overlayOpacity, setOverlayOpacity] = useState(() => readStoredOpacity());

  const applyOverlayOpacity = (raw: number) => {
    const v = clampUiOpacity(raw);
    setOverlayOpacity(v);
    localStorage.setItem(OVERLAY_OPACITY_STORAGE, String(v));
    void api.overlaySetOpacity(v);
  };

  const {
    capabilities,
    interactionMode,
    sttRunning,
    liveLine,
    transcriptLog,
    manualNotes,
    answer,
    uiMode,
    generating,
    error,
    setCapabilities,
    setInteractionMode,
    setSttRunning,
    setLiveLine,
    appendFinalTranscript,
    setManualNotes,
    rebuildSummary,
    setAnswer,
    setUiMode,
    setGenerating,
    setError,
    setLastGenerateKey,
    clearSession,
  } = useCopilotStore();

  const runGenerate = useCallback(
    async (latest: string, modeOverride?: GenerateMode) => {
      const mode = modeOverride ?? uiMode;
      const trimmed = latest.trim();
      if (!trimmed || !capabilities.aiReady) return;

      rebuildSummary();
      const summary = useCopilotStore.getState().conversationSummary;
      const manual = useCopilotStore.getState().manualNotes;
      const key = `${trimmed}|${mode}|${summary.slice(-200)}`;
      if (useCopilotStore.getState().lastGenerateKey === key) return;
      setLastGenerateKey(key);

      setGenerating(true);
      setError(null);
      const res = await api.aiGenerate({
        latestUtterance: trimmed,
        conversationSummary: summary,
        manualContext: manual || undefined,
        mode,
      });
      setGenerating(false);
      if (res.ok) setAnswer(res.answer);
      else setError(res.error);
    },
    [
      capabilities.aiReady,
      rebuildSummary,
      setAnswer,
      setError,
      setGenerating,
      setLastGenerateKey,
      uiMode,
    ],
  );

  const scheduleGenerateAfterSttSilence = useCallback(
    (chunk: string) => {
      const c = chunk.trim();
      if (!c) return;
      questionBurstRef.current = mergeQuestionBurst(questionBurstRef.current, c);
      if (silenceGenTimerRef.current) clearTimeout(silenceGenTimerRef.current);
      silenceGenTimerRef.current = setTimeout(() => {
        silenceGenTimerRef.current = null;
        const text = questionBurstRef.current.trim();
        questionBurstRef.current = '';
        if (text) void runGenerate(text);
      }, STT_SILENCE_BEFORE_GENERATE_MS);
    },
    [runGenerate],
  );

  const handleSendChat = async () => {
    const t = chatInput.trim();
    if (!t || !capabilities.aiReady || chatBusy) return;
    setChatInput('');
    const next: ChatTurn[] = [...chatMessages, { role: 'user', content: t }];
    setChatMessages(next);
    setChatBusy(true);
    setError(null);
    const res = await api.aiChat({ messages: next });
    setChatBusy(false);
    if (res.ok) {
      setChatMessages([...next, { role: 'assistant', content: res.text }]);
    } else {
      setError(res.error);
    }
  };

  useEffect(() => {
    const v = readStoredOpacity();
    setOverlayOpacity(v);
    void api.overlaySetOpacity(v);
  }, []);

  useEffect(() => {
    const solid = Math.round(overlayOpacity * 100) >= 99;
    document.documentElement.classList.toggle('copilot-solid', solid);
    return () => document.documentElement.classList.remove('copilot-solid');
  }, [overlayOpacity]);

  const refreshMicDevices = useCallback(async () => {
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      setMicDevices(list.filter((d) => d.kind === 'audioinput'));
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (toolsOpen) void refreshMicDevices();
  }, [toolsOpen, refreshMicDevices]);

  useEffect(() => {
    const onChange = () => {
      void refreshMicDevices();
      if (sttRunning) setDeviceChangeHint(true);
    };
    navigator.mediaDevices.addEventListener('devicechange', onChange);
    return () =>
      navigator.mediaDevices.removeEventListener('devicechange', onChange);
  }, [sttRunning, refreshMicDevices]);

  useEffect(() => {
    void api.capabilities().then((c) => {
      setCapabilities(c);
      const stored = localStorage.getItem(CAPTURE_SHIELD_STORAGE);
      const enabled =
        stored === '1'
          ? true
          : stored === '0'
            ? false
            : c.captureShieldDefault;
      setCaptureShield(enabled);
      void api.shieldSet(enabled);
    });
    void api.overlayGetInteraction().then(setInteractionMode);
  }, [setCapabilities, setInteractionMode]);

  useEffect(() => {
    const off = api.onInteraction((enabled) => setInteractionMode(enabled));
    return off;
  }, [setInteractionMode]);

  useEffect(() => {
    const offT = api.onTranscript((ev) => {
      if (!ev.isFinal && !ev.speechFinal) {
        setLiveLine(ev.text);
        return;
      }
      setLiveLine(ev.text);
      const t = ev.text.trim();
      if (!t) return;
      if (ev.speechFinal) {
        if (finalFallbackTimerRef.current) {
          clearTimeout(finalFallbackTimerRef.current);
          finalFallbackTimerRef.current = null;
        }
        appendFinalTranscript(t);
        rebuildSummary();
        scheduleGenerateAfterSttSilence(t);
        return;
      }
      if (ev.isFinal) {
        if (finalFallbackTimerRef.current) {
          clearTimeout(finalFallbackTimerRef.current);
        }
        finalFallbackTimerRef.current = setTimeout(() => {
          appendFinalTranscript(t);
          rebuildSummary();
          scheduleGenerateAfterSttSilence(t);
        }, 750);
      }
    });
    const offE = api.onSttError((msg) => setError(msg));
    return () => {
      offT();
      offE();
      if (finalFallbackTimerRef.current) {
        clearTimeout(finalFallbackTimerRef.current);
        finalFallbackTimerRef.current = null;
      }
      if (silenceGenTimerRef.current) {
        clearTimeout(silenceGenTimerRef.current);
        silenceGenTimerRef.current = null;
      }
      questionBurstRef.current = '';
    };
  }, [
    appendFinalTranscript,
    rebuildSummary,
    scheduleGenerateAfterSttSilence,
    setError,
    setLiveLine,
  ]);

  const toggleStt = async () => {
    setError(null);
    setAudioHint(null);
    if (sttRunning) {
      if (silenceGenTimerRef.current) {
        clearTimeout(silenceGenTimerRef.current);
        silenceGenTimerRef.current = null;
      }
      questionBurstRef.current = '';
      await stopCaptureRef.current?.();
      stopCaptureRef.current = null;
      await api.sttStop();
      setSttRunning(false);
      return;
    }
    if (!capabilities.hasDeepgram) {
      setError('Add DEEPGRAM_API_KEY to .env for live STT.');
      return;
    }
    try {
      const audioOpts = {
        deviceId: micDeviceId || undefined,
        micGain,
        tabGain,
        headsetMode,
      };
      const capture = includeMeetTabAudio
        ? await startMeetMixedPcmCapture((pcm) => api.sttSendPcm(pcm), {
            ...audioOpts,
            includeMeetTabAudio: true,
            systemAudioOnly: sttSystemAudioOnly,
          })
        : await startMicPcmCapture((pcm) => api.sttSendPcm(pcm), audioOpts);
      setDeviceChangeHint(false);

      if (includeMeetTabAudio && !capture.hadMeetTabAudio && !sttSystemAudioOnly) {
        setAudioHint(
          capabilities.platform === 'win32'
            ? 'Mic only: system audio was not attached. Allow the capture prompt, check Windows Privacy → Microphone, and ensure sound plays on your default output device.'
            : 'Mic only: tab audio was not shared. When prompted, select the Meet tab and turn ON “Share tab audio”.',
        );
      }

      const started = await api.sttStart({ sampleRate: capture.sampleRate });
      if (!started.ok) {
        await capture.stop();
        setError(started.error);
        return;
      }
      stopCaptureRef.current = capture.stop;
      setSttRunning(true);
    } catch (e) {
      const name = e instanceof DOMException ? e.name : '';
      if (name === 'NotAllowedError' || name === 'AbortError') {
        setError(
          'Tab/window capture was cancelled or blocked. Allow screen capture for this app, or turn off “Capture Meet tab audio”.',
        );
        return;
      }
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const toggleInteraction = async () => {
    const next = !interactionMode;
    const v = await api.overlaySetInteraction(next);
    setInteractionMode(v);
  };

  const onManualSubmit = () => {
    rebuildSummary();
    const line = manualNotes.trim();
    if (line) appendFinalTranscript(line);
    void runGenerate(line || transcriptLog.slice(-400));
  };

  const clearConversation = () => {
    if (silenceGenTimerRef.current) {
      clearTimeout(silenceGenTimerRef.current);
      silenceGenTimerRef.current = null;
    }
    questionBurstRef.current = '';
    if (finalFallbackTimerRef.current) {
      clearTimeout(finalFallbackTimerRef.current);
      finalFallbackTimerRef.current = null;
    }
    clearSession();
    setAudioHint(null);
  };

  const clearChatOnly = () => {
    setChatMessages([]);
    setChatInput('');
  };

  /** Slider ≥99%: opaque CSS panels (no /94 alpha, no backdrop blur) so the desktop doesn’t show through. */
  const solidChrome = Math.round(overlayOpacity * 100) >= 99;

  return (
    <div
      className={`flex h-full flex-col overflow-hidden rounded-xl border border-copilot-border text-slate-200 shadow-2xl ${
        solidChrome
          ? 'bg-copilot-bg'
          : 'bg-copilot-bg/94 backdrop-blur-md'
      }`}
    >
      <TitleBar
        interactionMode={interactionMode}
        toolsOpen={toolsOpen}
        solidChrome={solidChrome}
        onToggleInteraction={() => void toggleInteraction()}
        onToggleTools={() => setToolsOpen((o) => !o)}
        onMinimize={() => void api.windowHide()}
      />

      <div
        className={`no-drag flex items-center gap-3 border-b border-copilot-border/60 px-3 py-1.5 ${
          solidChrome ? 'bg-copilot-surface' : 'bg-copilot-surface/40'
        }`}
      >
        <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-copilot-muted">
          Window opacity
        </span>
        <span className="shrink-0 text-[9px] text-copilot-muted">Ghost</span>
        <input
          type="range"
          min={0.15}
          max={1}
          step={0.05}
          value={overlayOpacity}
          onChange={(e) => applyOverlayOpacity(parseFloat(e.target.value))}
          className="h-1.5 min-w-0 flex-1 cursor-pointer accent-copilot-accent"
          title="Whole overlay transparency (Electron). Higher = easier to read chat."
        />
        <span className="shrink-0 text-[9px] text-copilot-muted">Solid</span>
        <span className="w-9 shrink-0 text-right text-[10px] tabular-nums text-slate-300">
          {Math.round(overlayOpacity * 100)}%
        </span>
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col">
        <ToolsDrawer
          open={toolsOpen}
          solidChrome={solidChrome}
          onClose={() => setToolsOpen(false)}
        >
          <div className="flex flex-col gap-4 text-[11px]">
            <div className="flex flex-wrap gap-2">
              <span
                className={`rounded-md px-2 py-1 ${capabilities.aiReady ? 'bg-emerald-900/45 text-emerald-200' : 'bg-red-900/35 text-red-200'}`}
              >
                AI {capabilities.aiReady ? capabilities.aiProvider : 'off'}
              </span>
              <span
                className={`rounded-md px-2 py-1 ${capabilities.hasDeepgram ? 'bg-emerald-900/45 text-emerald-200' : 'bg-amber-900/35 text-amber-100'}`}
              >
                Deepgram {capabilities.hasDeepgram ? 'on' : 'off'}
              </span>
            </div>
            <p className="leading-relaxed text-copilot-muted">
              Alt+Shift+O hide window · Alt+Shift+I interact / click-through
            </p>

            <div className="rounded-lg border border-copilot-border/80 bg-copilot-surface/30 p-2.5">
              <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-copilot-muted">
                Window opacity (same as top bar)
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[9px] text-copilot-muted">15%</span>
                <input
                  type="range"
                  min={0.15}
                  max={1}
                  step={0.05}
                  value={overlayOpacity}
                  onChange={(e) =>
                    applyOverlayOpacity(parseFloat(e.target.value))
                  }
                  className="h-1.5 min-w-0 flex-1 cursor-pointer accent-copilot-accent"
                />
                <span className="text-[9px] text-copilot-muted">100%</span>
                <span className="w-8 text-right text-[10px] tabular-nums text-slate-300">
                  {Math.round(overlayOpacity * 100)}%
                </span>
              </div>
              <p className="mt-1.5 text-[10px] leading-snug text-copilot-muted">
                Controls the whole window so you can see the desktop through it
                or make text more readable at 100%.
              </p>
            </div>

            <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-copilot-border/80 bg-copilot-surface/40 p-2.5">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={captureShield}
                onChange={(e) => {
                  const on = e.target.checked;
                  localStorage.setItem(CAPTURE_SHIELD_STORAGE, on ? '1' : '0');
                  setCaptureShield(on);
                  void api.shieldSet(on);
                }}
              />
              <span>
                <span className="font-medium text-slate-100">
                  Hide from screen share
                </span>
                <span className="mt-0.5 block text-copilot-muted">
                  You still see the overlay locally.
                </span>
              </span>
            </label>

            <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-copilot-border/80 bg-copilot-surface/30 p-2.5">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={includeMeetTabAudio}
                onChange={(e) => {
                  const on = e.target.checked;
                  localStorage.setItem(MEET_TAB_AUDIO_STORAGE, on ? '1' : '0');
                  setIncludeMeetTabAudio(on);
                }}
              />
              <span>
                <span className="font-medium text-slate-100">
                  {capabilities.platform === 'win32'
                    ? 'Meet + system audio (Windows)'
                    : 'Meet / tab audio'}
                </span>
                <span className="mt-0.5 block text-copilot-muted">
                  {capabilities.platform === 'win32'
                    ? 'Uses your primary display for capture permission; audio is system loopback (what plays on your default output). The next checkbox controls whether your microphone is mixed in or left out.'
                    : 'When starting STT, pick the browser tab where Meet runs and turn on “Share tab audio”. The next checkbox can exclude your mic so only tab audio is transcribed.'}
                </span>
              </span>
            </label>

            {includeMeetTabAudio ? (
              <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-copilot-border/80 bg-copilot-surface/30 p-2.5">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={sttSystemAudioOnly}
                  onChange={(e) => {
                    const on = e.target.checked;
                    localStorage.setItem(STT_SYSTEM_ONLY_STORAGE, on ? '1' : '0');
                    setSttSystemAudioOnly(on);
                  }}
                />
                <span>
                  <span className="font-medium text-slate-100">
                    System / tab audio only (no microphone)
                  </span>
                  <span className="mt-0.5 block text-copilot-muted">
                    {capabilities.platform === 'win32'
                      ? 'STT listens to default playback (loopback) only — not your headset or USB mic. Uncheck to mix in your voice with remote audio.'
                      : 'STT uses shared tab audio only. Uncheck to also capture your microphone.'}
                  </span>
                </span>
              </label>
            ) : null}

            <div className="rounded-lg border border-copilot-border/80 bg-copilot-surface/30 p-2.5">
              <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-copilot-muted">
                Mic &amp; levels
              </div>
              <p className="mb-2 text-[10px] leading-snug text-copilot-muted">
                {includeMeetTabAudio && sttSystemAudioOnly ? (
                  <>
                    <strong className="text-slate-400">System-only</strong> — mic
                    gain and device are ignored. Adjust{' '}
                    <strong className="text-slate-400">tab gain</strong> if STT is
                    too quiet or loud.
                  </>
                ) : capabilities.platform === 'win32' && includeMeetTabAudio ? (
                  <>
                    With <strong className="text-slate-400">Meet + system audio</strong>, STT
                    hears the same mix as your default output (headphones or
                    speakers). Use mic / tab gain to balance your voice vs remote.
                  </>
                ) : (
                  <>
                    Without system capture,{' '}
                    <strong className="text-slate-400">speaker</strong> volume may not match
                    what is sent to STT. Use mic / tab gain to tune levels. Plugging
                    headphones can switch the default mic — pick it below or restart
                    STT after a device change.
                  </>
                )}
              </p>
              <label className="mb-2 flex cursor-pointer items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={headsetMode}
                  disabled={includeMeetTabAudio && sttSystemAudioOnly}
                  onChange={(e) => {
                    const on = e.target.checked;
                    localStorage.setItem(HEADSET_MODE_STORAGE, on ? '1' : '0');
                    setHeadsetMode(on);
                  }}
                />
                <span className="text-[11px] leading-snug text-slate-200">
                  <span className="font-medium">Headset / earbuds mode</span>
                  <span className="mt-0.5 block text-copilot-muted">
                    Disables mic echo cancellation and auto gain for clearer
                    transcription with headphones.
                  </span>
                </span>
              </label>
              <div className="mb-2 flex flex-wrap items-end gap-2">
                <label className="min-w-0 flex-1 text-[10px] text-copilot-muted">
                  Microphone
                  <select
                    value={micDeviceId}
                    disabled={includeMeetTabAudio && sttSystemAudioOnly}
                    onChange={(e) => {
                      const id = e.target.value;
                      localStorage.setItem(MIC_DEVICE_STORAGE, id);
                      setMicDeviceId(id);
                    }}
                    className="mt-0.5 w-full rounded-md border border-copilot-border bg-copilot-bg px-2 py-1.5 text-[11px] text-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <option value="">Default (follows Windows)</option>
                    {micDevices.map((d) => (
                      <option key={d.deviceId} value={d.deviceId}>
                        {d.label || `Input ${d.deviceId.slice(0, 8)}…`}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  disabled={includeMeetTabAudio && sttSystemAudioOnly}
                  onClick={() => void refreshMicDevices()}
                  className="shrink-0 rounded-md border border-copilot-border px-2 py-1.5 text-[10px] text-slate-300 hover:bg-copilot-surface disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Refresh list
                </button>
              </div>
              <div className="mb-2 flex items-center gap-2">
                <span className="w-16 shrink-0 text-[9px] text-copilot-muted">
                  Mic gain
                </span>
                <input
                  type="range"
                  min={0.25}
                  max={2}
                  step={0.05}
                  value={micGain}
                  disabled={includeMeetTabAudio && sttSystemAudioOnly}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    localStorage.setItem(MIC_GAIN_STORAGE, String(v));
                    setMicGain(v);
                  }}
                  className="h-1.5 min-w-0 flex-1 cursor-pointer accent-copilot-accent"
                />
                <span className="w-10 shrink-0 text-right text-[10px] tabular-nums text-slate-300">
                  {Math.round(micGain * 100)}%
                </span>
              </div>
              {includeMeetTabAudio ? (
                <div className="flex items-center gap-2">
                  <span className="w-16 shrink-0 text-[9px] text-copilot-muted">
                    Tab gain
                  </span>
                  <input
                    type="range"
                    min={0.25}
                    max={2}
                    step={0.05}
                    value={tabGain}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value);
                      localStorage.setItem(TAB_GAIN_STORAGE, String(v));
                      setTabGain(v);
                    }}
                    className="h-1.5 min-w-0 flex-1 cursor-pointer accent-copilot-accent"
                  />
                  <span className="w-10 shrink-0 text-right text-[10px] tabular-nums text-slate-300">
                    {Math.round(tabGain * 100)}%
                  </span>
                </div>
              ) : null}
            </div>

            {deviceChangeHint ? (
              <div className="rounded-lg border border-amber-800/50 bg-amber-950/30 p-2 text-[10px] text-amber-100">
                Audio devices changed while STT was on. Stop STT, confirm the
                microphone above, then start again.
              </div>
            ) : null}

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void toggleStt()}
                className={`rounded-lg px-3 py-2 text-xs font-semibold ${
                  sttRunning
                    ? 'bg-rose-600 text-white'
                    : 'bg-copilot-accent/20 text-copilot-accent'
                }`}
              >
                {sttRunning
                  ? 'Stop STT'
                  : includeMeetTabAudio
                    ? capabilities.platform === 'win32'
                      ? 'Start STT + system'
                      : 'Start STT + tab'
                    : 'Start mic STT'}
              </button>
              <button
                type="button"
                disabled={generating || !capabilities.aiReady}
                onClick={() =>
                  void runGenerate(
                    liveLine || transcriptLog.slice(-500) || manualNotes,
                  )
                }
                className="rounded-lg bg-copilot-surface px-3 py-2 text-xs font-medium text-slate-100 disabled:opacity-40"
              >
                {generating ? '…' : 'Run AI on last text'}
              </button>
              <button
                type="button"
                disabled={!answer}
                onClick={() =>
                  answer &&
                  void navigator.clipboard.writeText(
                    formatAnswerForClipboard(answer),
                  )
                }
                className="rounded-lg bg-copilot-surface px-3 py-2 text-xs font-medium disabled:opacity-40"
              >
                Copy session answer
              </button>
            </div>

            <div className="flex flex-wrap gap-1.5">
              {(
                [
                  ['full', 'Full'],
                  ['hint_only', 'Hint'],
                  ['explain_simpler', 'Simpler'],
                ] as const
              ).map(([m, label]) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => {
                    setUiMode(m);
                    void runGenerate(
                      liveLine || transcriptLog.slice(-500) || manualNotes,
                      m,
                    );
                  }}
                  className={`rounded-md px-2.5 py-1.5 text-[11px] font-medium ${
                    uiMode === m
                      ? 'bg-copilot-accent/25 text-copilot-accent'
                      : 'bg-copilot-bg text-slate-400'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            <div>
              <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-copilot-muted">
                Manual / paste question
              </label>
              <textarea
                value={manualNotes}
                onChange={(e) => setManualNotes(e.target.value)}
                rows={4}
                className="w-full resize-none rounded-lg border border-copilot-border bg-copilot-surface/90 p-2 font-mono text-xs text-slate-100"
                placeholder="If audio isn’t available…"
              />
              <button
                type="button"
                onClick={onManualSubmit}
                className="mt-2 rounded-lg bg-copilot-border px-3 py-1.5 text-[11px] font-medium text-slate-100"
              >
                Append &amp; run AI
              </button>
            </div>

            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-copilot-muted">
                Session transcript
              </div>
              <div className="max-h-40 overflow-auto rounded-lg border border-dashed border-copilot-border/70 bg-black/25 p-2 font-mono text-[10px] text-slate-400">
                <div className="text-copilot-accent/90">
                  Live: {liveLine || '—'}
                </div>
                <div className="mt-1 whitespace-pre-wrap text-slate-300">
                  {transcriptLog || '—'}
                </div>
              </div>
            </div>

            {audioHint ? (
              <div className="rounded-lg border border-amber-800/50 bg-amber-950/30 p-2 text-amber-100">
                {audioHint}
              </div>
            ) : null}

            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={clearConversation}
                className="rounded-lg border border-rose-900/50 bg-rose-950/25 py-2 text-xs font-medium text-rose-200/90 hover:bg-rose-950/40"
              >
                Clear session (transcript + answer)
              </button>
              <button
                type="button"
                onClick={clearChatOnly}
                className="rounded-lg border border-copilot-border py-2 text-xs text-slate-400 hover:bg-copilot-surface"
              >
                Clear chat only
              </button>
            </div>
          </div>
        </ToolsDrawer>

        <div className="no-drag flex min-h-0 flex-1 flex-col">
          <div
            className={`flex shrink-0 items-center gap-3 border-b border-copilot-border/70 px-4 py-2.5 ${
              solidChrome ? 'bg-copilot-surface' : 'bg-copilot-surface/30'
            }`}
          >
            <span className="text-[10px] font-bold uppercase tracking-wider text-copilot-muted">
              Live
            </span>
            <p className="min-w-0 flex-1 truncate text-sm text-cyan-100/95">
              {liveLine || 'Waiting for speech…'}
            </p>
            {sttRunning ? (
              <span
                className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-red-500"
                title="STT on"
              />
            ) : null}
            {generating ? (
              <span className="shrink-0 text-[10px] text-copilot-accent">
                AI…
              </span>
            ) : null}
            <button
              type="button"
              onClick={clearConversation}
              title="Clear transcript, manual notes, and session answer"
              className={`no-drag shrink-0 rounded-lg border border-copilot-border/90 px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400 hover:border-rose-800/60 hover:bg-rose-950/30 hover:text-rose-200 ${
                solidChrome ? 'bg-copilot-surface' : 'bg-copilot-bg/80'
              }`}
            >
              Clear conversation
            </button>
          </div>

          <div
            className={`min-h-0 flex-1 overflow-y-auto px-5 py-4 ${
              solidChrome ? 'bg-copilot-bg' : ''
            }`}
          >
            {answer ? (
              <AnswerCard answer={answer} solidChrome={solidChrome} />
            ) : (
              <div className="flex h-full min-h-[12rem] flex-col items-center justify-center gap-3 text-center">
                <p className="max-w-md text-lg font-medium text-slate-400">
                  Session answer appears here — wide layout for code and
                  explanations.
                </p>
                <p className="max-w-sm text-sm text-copilot-muted">
                  Turn on STT in Tools, or paste a question there. Use{' '}
                  <strong className="text-slate-500">Chat</strong> below for
                  freeform Q&amp;A.
                </p>
              </div>
            )}
          </div>

          {error ? (
            <div className="shrink-0 border-t border-red-900/40 bg-red-950/35 px-4 py-2 text-sm text-red-200">
              {error}
            </div>
          ) : null}

          <ChatDock
            messages={chatMessages}
            input={chatInput}
            onInputChange={setChatInput}
            onSend={() => void handleSendChat()}
            onClearChat={clearChatOnly}
            solidChrome={solidChrome}
            busy={chatBusy}
            disabled={!capabilities.aiReady}
          />
        </div>
      </div>
    </div>
  );
}
