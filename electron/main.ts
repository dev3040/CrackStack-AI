import {
  app,
  BrowserWindow,
  desktopCapturer,
  globalShortcut,
  ipcMain,
  screen,
  session,
} from 'electron';
import path from 'node:path';
import dotenv from 'dotenv';
import { DeepgramLiveSession, type TranscriptEvent } from './services/deepgramLive';
import {
  analyzeScreenshot,
  generateInterviewAnswer,
  generateStructuredAnswer,
  generateResumeQuestions,
  getAiCapabilitiesFromEnv,
  parseResume,
  resolveAllLlmConfigs,
  resolveVisionConfigs,
  runChatCompletion,
  type ChatTurn,
  type CopilotAnswer,
  type GenerateInput,
  type GenerateMode,
  type LlmConfig,
  type ResumeData,
} from './services/aiPipeline';

dotenv.config({ path: path.join(__dirname, '../../.env') });

let overlay: BrowserWindow | null = null;
let dgSession: DeepgramLiveSession | null = null;
let interactionMode = false;
let allLlmCache: LlmConfig[] | null = null;
let visionLlmCache: LlmConfig[] | null = null;

/** Hide overlay from screen capture / share (you still see it locally). Off if CONTENT_PROTECTION=false in .env */
let captureShieldEnabled =
  String(process.env.CONTENT_PROTECTION ?? 'true').toLowerCase() !== 'false';

/** Whole-window opacity (0.15–1). Separate from CSS; adjusted via Tools slider. */
let overlayUserOpacity = 1;

// ---------------------------------------------------------------------------
// Answer cache — avoids re-calling the LLM for the same question within 5 min
// ---------------------------------------------------------------------------
type CacheEntry = { answer: CopilotAnswer; ts: number };
const answerCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000;

function answerCacheKey(input: GenerateInput): string {
  const raw = `${input.mode}|${input.latestUtterance.trim().toLowerCase()}|${(input.manualContext ?? '').trim()}`;
  let h = 5381;
  for (let i = 0; i < raw.length; i++) {
    h = (Math.imul(h, 31) + raw.charCodeAt(i)) | 0;
  }
  return String(h >>> 0);
}

function getCachedAnswer(input: GenerateInput): CopilotAnswer | null {
  const key = answerCacheKey(input);
  const entry = answerCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    answerCache.delete(key);
    return null;
  }
  return entry.answer;
}

function setCachedAnswer(input: GenerateInput, answer: CopilotAnswer): void {
  // Evict stale entries occasionally to avoid unbounded growth
  if (answerCache.size > 200) {
    const now = Date.now();
    for (const [k, v] of answerCache) {
      if (now - v.ts > CACHE_TTL_MS) answerCache.delete(k);
    }
  }
  answerCache.set(answerCacheKey(input), { answer, ts: Date.now() });
}

// ---------------------------------------------------------------------------

function clampOverlayOpacity(v: number): number {
  if (!Number.isFinite(v)) return 1;
  return Math.min(1, Math.max(0.15, v));
}

/** Match renderer `copilot.bg` — opaque ARGB so transparent windows don't show the desktop through gaps. */
const OVERLAY_SOLID_BG = '#FF0c0d10';
const OVERLAY_CLEAR_BG = '#00000000';

function isSolidOverlayOpacity(o: number): boolean {
  return clampOverlayOpacity(o) >= 0.99;
}

function syncOverlayNativeBackdrop(win: BrowserWindow | null) {
  if (!win || win.isDestroyed()) return;
  try {
    win.setBackgroundColor(
      isSolidOverlayOpacity(overlayUserOpacity)
        ? OVERLAY_SOLID_BG
        : OVERLAY_CLEAR_BG,
    );
  } catch {
    /* unsupported */
  }
}

/**
 * Maps to OS capture exclusion (Windows: WDA_EXCLUDEFROMCAPTURE on recent builds;
 * macOS: non-shared window). Reapplied on show/load because some drivers drop it.
 * Keeps user window opacity (does not force 1.0).
 */
function applyCaptureShield(win: BrowserWindow | null) {
  if (!win || win.isDestroyed()) return;
  try {
    const o = clampOverlayOpacity(overlayUserOpacity);
    syncOverlayNativeBackdrop(win);
    if (captureShieldEnabled) {
      win.setOpacity(o);
      win.setContentProtection(true);
    } else {
      win.setContentProtection(false);
      win.setOpacity(o);
    }
  } catch {
    /* unsupported platform / headless */
  }
}

function attachCaptureShieldHooks(win: BrowserWindow) {
  const reapply = () => applyCaptureShield(win);
  win.webContents.on('did-finish-load', reapply);
  win.on('show', reapply);
  win.on('restore', reapply);
  win.on('resized', reapply);
  win.on('moved', reapply);
}

function getAllLlm(): LlmConfig[] {
  if (!allLlmCache) allLlmCache = resolveAllLlmConfigs();
  return allLlmCache;
}

function getVisionLlm(): LlmConfig[] {
  if (!visionLlmCache) visionLlmCache = resolveVisionConfigs();
  return visionLlmCache;
}

function applyClickThrough(clickThrough: boolean) {
  if (!overlay || overlay.isDestroyed()) return;
  if (clickThrough) {
    overlay.setIgnoreMouseEvents(true, { forward: true });
  } else {
    overlay.setIgnoreMouseEvents(false);
  }
}

function broadcastTranscript(ev: TranscriptEvent) {
  if (!overlay || overlay.isDestroyed()) return;
  overlay.webContents.send('copilot:transcript', ev);
}

function broadcastMode(mode: GenerateMode) {
  if (!overlay || overlay.isDestroyed()) return;
  overlay.webContents.send('copilot:mode', mode);
}

/**
 * Windows: Chromium/Electron often returns **no audio track** from getDisplayMedia.
 * Route display-capture through desktopCapturer + WASAPI **loopback** so Meet/browser
 * audio on the default playback device is included (follows what you hear on speakers/headphones).
 * @see https://www.electronjs.org/docs/latest/api/session#sessetdisplaymediarequesthandlerhandler-opts
 */
function installDisplayMediaHandler() {
  if (process.platform !== 'win32') return;

  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    void (async () => {
      try {
        const sources = await desktopCapturer.getSources({
          types: ['screen', 'window'],
          thumbnailSize: { width: 1, height: 1 },
          fetchWindowIcons: false,
        });

        const screenSources = sources.filter((s) => s.id.startsWith('screen:'));
        const primary = screen.getPrimaryDisplay();
        const video =
          screenSources.find(
            (s) =>
              s.display_id !== '' &&
              s.display_id === String(primary.id),
          ) ?? screenSources[0] ?? sources[0];

        if (!video) {
          callback({});
          return;
        }

        const streams: { video: Electron.DesktopCapturerSource; audio?: 'loopback' } =
          { video };
        if (request.audioRequested) {
          streams.audio = 'loopback';
        }
        callback(streams);
      } catch {
        callback({});
      }
    })();
  });
}

function createOverlayWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  overlay = new BrowserWindow({
    width: 880,
    height: 720,
    x: workArea.x + workArea.width - 900,
    y: workArea.y + 40,
    minWidth: 520,
    minHeight: 440,
    show: true,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    /** Hide from Windows taskbar (Alt+Shift+O still toggles window). Set SHOW_IN_TASKBAR=true to show. */
    skipTaskbar: process.env.SHOW_IN_TASKBAR !== 'true',
    hasShadow: false,
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  interactionMode = false;
  applyClickThrough(true);
  applyCaptureShield(overlay);
  attachCaptureShieldHooks(overlay);

  const devUrl = 'http://localhost:5173';
  const prodFile = path.join(__dirname, '../../dist/renderer/index.html');

  if (!app.isPackaged) {
    void overlay.loadURL(devUrl);
  } else {
    void overlay.loadFile(prodFile);
  }

  overlay.on('closed', () => {
    overlay = null;
  });
}

function registerShortcuts() {
  const retoggle = () => {
    if (!overlay || overlay.isDestroyed()) return;
    if (overlay.isVisible()) overlay.hide();
    else overlay.show();
  };

  const toggleInteraction = () => {
    interactionMode = !interactionMode;
    applyClickThrough(!interactionMode);
    if (overlay && !overlay.isDestroyed()) {
      overlay.webContents.send('copilot:interaction', interactionMode);
    }
  };

  const registered: string[] = [];
  const tryReg = (acc: string, fn: () => void) => {
    try {
      if (globalShortcut.register(acc, fn)) registered.push(acc);
    } catch {
      /* ignore */
    }
  };

  tryReg('Alt+Shift+O', retoggle);
  tryReg('Alt+Shift+I', toggleInteraction);

  // Mode shortcuts: Alt+1 = Full, Alt+2 = Hint, Alt+3 = Simpler
  tryReg('Alt+1', () => broadcastMode('full'));
  tryReg('Alt+2', () => broadcastMode('hint_only'));
  tryReg('Alt+3', () => broadcastMode('explain_simpler'));

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
  });
}

function setupIpc() {
  ipcMain.handle('app:capabilities', () => {
    const ai = getAiCapabilitiesFromEnv();
    return {
      aiReady: ai.aiReady,
      aiProvider: ai.aiProvider,
      hasDeepgram: Boolean(process.env.DEEPGRAM_API_KEY?.trim()),
      captureShieldDefault:
        String(process.env.CONTENT_PROTECTION ?? 'true').toLowerCase() !==
        'false',
      platform: process.platform,
    };
  });

  ipcMain.handle('shield:get', () => captureShieldEnabled);

  ipcMain.handle('shield:set', (_e, enabled: boolean) => {
    captureShieldEnabled = Boolean(enabled);
    applyCaptureShield(overlay);
    return captureShieldEnabled;
  });

  ipcMain.handle('overlay:setInteraction', (_e, enabled: boolean) => {
    interactionMode = Boolean(enabled);
    applyClickThrough(!interactionMode);
    return interactionMode;
  });

  ipcMain.handle('overlay:getInteraction', () => interactionMode);

  ipcMain.handle('overlay:setOpacity', (_e, raw: unknown) => {
    const n = typeof raw === 'number' ? raw : parseFloat(String(raw));
    overlayUserOpacity = clampOverlayOpacity(n);
    if (overlay && !overlay.isDestroyed()) {
      syncOverlayNativeBackdrop(overlay);
      overlay.setOpacity(overlayUserOpacity);
    }
    return { ok: true as const, opacity: overlayUserOpacity };
  });

  ipcMain.handle('overlay:getOpacity', () => clampOverlayOpacity(overlayUserOpacity));

  ipcMain.handle('window:hide', () => {
    overlay?.hide();
    return { ok: true as const };
  });

  ipcMain.handle(
    'stt:start',
    (_e, opts: { sampleRate: number } | undefined) => {
      const key = process.env.DEEPGRAM_API_KEY;
      if (!key) {
        return { ok: false as const, error: 'DEEPGRAM_API_KEY missing in .env' };
      }
      dgSession?.close();
      const sampleRate = opts?.sampleRate ?? 16_000;
      dgSession = new DeepgramLiveSession(
        key,
        {
          onTranscript: (ev) => broadcastTranscript(ev),
          onError: (err) => {
            if (overlay && !overlay.isDestroyed()) {
              overlay.webContents.send('copilot:stt-error', err.message);
            }
          },
          onClose: () => {
            dgSession = null;
            if (overlay && !overlay.isDestroyed()) {
              overlay.webContents.send('copilot:stt-closed');
            }
          },
          onReconnecting: (attempt) => {
            if (overlay && !overlay.isDestroyed()) {
              overlay.webContents.send('copilot:stt-reconnecting', attempt);
            }
          },
        },
        sampleRate,
      );
      dgSession.connect();
      return { ok: true as const };
    },
  );

  ipcMain.on('stt:pcm', (_e, payload: Uint8Array | Buffer) => {
    const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    dgSession?.sendPcm(buf);
  });

  ipcMain.handle('stt:stop', () => {
    dgSession?.close();
    dgSession = null;
    return { ok: true as const };
  });

  ipcMain.handle('ai:generate', async (_e, input: GenerateInput) => {
    try {
      // Return cached answer immediately if available
      const cached = getCachedAnswer(input);
      if (cached) {
        return { ok: true as const, answer: cached, cached: true };
      }
      const answer = await generateStructuredAnswer(getAllLlm(), input);
      setCachedAnswer(input, answer);
      return { ok: true as const, answer, cached: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false as const, error: message };
    }
  });

  ipcMain.handle(
    'ai:chat',
    async (_e, payload: { messages: ChatTurn[] }) => {
      try {
        const text = await runChatCompletion(getAllLlm(), payload.messages);
        return { ok: true as const, text };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false as const, error: message };
      }
    },
  );

  ipcMain.handle(
    'ai:analyze-screen',
    async (_e, context?: string) => {
      try {
        const visionCfgs = getVisionLlm();
        if (visionCfgs.length === 0) {
          return {
            ok: false as const,
            error:
              'Screen analysis needs a vision-capable provider. Add OPENAI_API_KEY or OPENROUTER_API_KEY to .env',
          };
        }

        // Hide overlay so it doesn't obscure the content we're analyzing
        const wasVisible = overlay ? !overlay.isDestroyed() && overlay.isVisible() : false;
        if (wasVisible) overlay?.hide();

        // Give the OS time to redraw before capturing
        await new Promise<void>((resolve) => setTimeout(resolve, 200));

        const sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: 1920, height: 1080 },
          fetchWindowIcons: false,
        });

        // Restore overlay immediately after capture
        if (wasVisible) overlay?.show();

        const primary = screen.getPrimaryDisplay();
        const source =
          sources.find(
            (s) =>
              s.display_id !== '' && s.display_id === String(primary.id),
          ) ??
          sources[0];

        if (!source) {
          return { ok: false as const, error: 'Could not capture the screen' };
        }

        const dataUrl = source.thumbnail.toDataURL();
        const answer = await analyzeScreenshot(visionCfgs, dataUrl, context);
        return { ok: true as const, answer };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false as const, error: message };
      }
    },
  );

  ipcMain.handle('resume:parse', async (_e, resumeText: string) => {
    try {
      const data = await parseResume(getAllLlm(), resumeText);
      return { ok: true as const, data };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false as const, error: message };
    }
  });

  ipcMain.handle('resume:questions', async (_e, resumeData: unknown) => {
    try {
      const questions = await generateResumeQuestions(getAllLlm(), resumeData as ResumeData);
      return { ok: true as const, questions };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false as const, error: message };
    }
  });

  ipcMain.handle(
    'resume:interview-answer',
    async (_e, payload: { question: string; resumeData: ResumeData }) => {
      try {
        const result = await generateInterviewAnswer(
          getAllLlm(),
          payload.question,
          payload.resumeData,
        );
        return { ok: true as const, result };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false as const, error: message };
      }
    },
  );

  ipcMain.handle(
    'resume:upload-file',
    async (_e, payload: { base64: string; mimeType: string; fileName: string }) => {
      try {
        const buffer = Buffer.from(payload.base64, 'base64');
        let text = '';

        if (
          payload.mimeType === 'application/pdf' ||
          payload.fileName.toLowerCase().endsWith('.pdf')
        ) {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const pdfParse = require('pdf-parse') as (
            buf: Buffer,
          ) => Promise<{ text: string }>;
          const data = await pdfParse(buffer);
          text = data.text;
        } else if (
          payload.mimeType ===
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
          payload.fileName.toLowerCase().endsWith('.docx')
        ) {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const mammoth = require('mammoth') as {
            extractRawText: (opts: { buffer: Buffer }) => Promise<{ value: string }>;
          };
          const result = await mammoth.extractRawText({ buffer });
          text = result.value;
        } else {
          // Plain text / .txt
          text = buffer.toString('utf-8');
        }

        if (!text.trim()) {
          return { ok: false as const, error: 'Could not extract text from file. Try a different format.' };
        }
        return { ok: true as const, text: text.trim() };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false as const, error: `File parse error: ${message}` };
      }
    },
  );
}

app.whenReady().then(() => {
  installDisplayMediaHandler();
  setupIpc();
  createOverlayWindow();
  registerShortcuts();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createOverlayWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
