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
  generateStructuredAnswer,
  getAiCapabilitiesFromEnv,
  resolveLlmConfig,
  runChatCompletion,
  type ChatTurn,
  type GenerateInput,
  type LlmConfig,
} from './services/aiPipeline';

dotenv.config({ path: path.join(__dirname, '../../.env') });

let overlay: BrowserWindow | null = null;
let dgSession: DeepgramLiveSession | null = null;
let interactionMode = false;
let llmCache: LlmConfig | null = null;

/** Hide overlay from screen capture / share (you still see it locally). Off if CONTENT_PROTECTION=false in .env */
let captureShieldEnabled =
  String(process.env.CONTENT_PROTECTION ?? 'true').toLowerCase() !== 'false';

/** Whole-window opacity (0.15–1). Separate from CSS; adjusted via Tools slider. */
let overlayUserOpacity = 1;

function clampOverlayOpacity(v: number): number {
  if (!Number.isFinite(v)) return 1;
  return Math.min(1, Math.max(0.15, v));
}

/** Match renderer `copilot.bg` — opaque ARGB so transparent windows don’t show the desktop through gaps. */
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

function getLlm(): LlmConfig {
  if (!llmCache) llmCache = resolveLlmConfig();
  return llmCache;
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
      const answer = await generateStructuredAnswer(getLlm(), input);
      return { ok: true as const, answer };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false as const, error: message };
    }
  });

  ipcMain.handle(
    'ai:chat',
    async (_e, payload: { messages: ChatTurn[] }) => {
      try {
        const text = await runChatCompletion(getLlm(), payload.messages);
        return { ok: true as const, text };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false as const, error: message };
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
