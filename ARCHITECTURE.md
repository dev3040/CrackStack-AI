# CrackStack AI — Architecture & Delivery

## 1. Desktop framework: Electron vs Tauri

**Choice: Electron**

| Criterion | Electron | Tauri |
|-----------|----------|-------|
| Transparent + always-on-top + `setIgnoreMouseEvents` | Mature, documented | Supported in v2, more edge cases |
| System / loopback audio + `desktopCapturer` | First-class Chromium APIs | Needs Rust plugins / OS-specific work |
| Streaming STT + AI from Node | `ws`, `openai`, simple IPC | Rust bridge or sidecar |
| Bundle size / RAM | Larger | Smaller |
| Screen-share exclusion (`setContentProtection`) | Available on supported OS builds | Platform-specific |

For **low-latency audio capture**, **overlay input modes**, and **fast iteration** on a streaming pipeline, Electron is the pragmatic pick. Tauri is better if binary size and baseline RAM matter more than audio/overlay ergonomics; you could later move hot paths to a Rust sidecar while keeping the UI in Tauri.

---

## 2. System architecture (text)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         OS (Windows / macOS / Linux)                      │
├─────────────────────────────────────────────────────────────────────────┤
│  Electron Main Process                                                    │
│  ├─ Overlay BrowserWindow (transparent, always-on-top, content protection)│
│  ├─ globalShortcut (toggle visibility, interaction mode)                │
│  ├─ IPC bridge (no raw keys in renderer)                                  │
│  ├─ STT: Deepgram WebSocket (live) — audio chunks from renderer           │
│  └─ AI: OpenAI Chat Completions (structured JSON) + conversation buffer   │
├─────────────────────────────────────────────────────────────────────────┤
│  Renderer (React + Zustand + Tailwind)                                    │
│  ├─ getDisplayMedia (system/tab audio) + getUserMedia (mic)               │
│  ├─ AudioWorklet / ScriptProcessor → PCM → IPC → main → Deepgram        │
│  ├─ Transcript buffer → debounce → classify + generate (IPC)              │
│  └─ UI: short / detail / code / hints, copy, modes                        │
└─────────────────────────────────────────────────────────────────────────┘
          │                              │
          ▼                              ▼
   Deepgram (WSS)                 OpenAI (HTTPS)
```

**Data flow (target <2s perceived latency):**

1. Capture mic + (optional) system audio → downmix/mono 16 kHz PCM.
2. Stream PCM to Deepgram; emit partial transcripts (interim results).
3. On phrase end (Deepgram `speech_final` or VAD silence), append to rolling context window.
4. Classify question type + generate answer in **one** structured completion (or parallel: classify tiny model + generate).
5. Stream tokens back to overlay (optional) for “typing” effect.

---

## 3. Folder structure

```
d:\tp\
├── ARCHITECTURE.md          # This file
├── package.json
├── tsconfig.json            # Renderer (Vite)
├── tsconfig.electron.json   # Main process
├── vite.config.ts
├── tailwind.config.js
├── postcss.config.js
├── index.html
├── electron/
│   ├── main.ts              # App lifecycle, overlay window, shortcuts
│   ├── preload.ts           # contextBridge API
│   └── services/
│       ├── deepgramLive.ts  # Live STT WebSocket client
│       └── aiPipeline.ts    # Classification + answer JSON
├── src/
│   ├── main.tsx
│   ├── index.css
│   ├── App.tsx
│   ├── vite-env.d.ts
│   ├── store/
│   │   └── useCopilotStore.ts
│   ├── components/
│   │   ├── TitleBar.tsx
│   │   └── AnswerCard.tsx
│   └── audio/
│       ├── capture.ts       # getDisplayMedia + getUserMedia
│       └── pcmWorklet.ts    # Float32 → Int16LE for STT
├── dist-electron/           # tsc output (gitignored)
│   └── electron/            # entry: electron/main.js (see package.json "main")
└── dist/renderer/           # Vite output (gitignored)
```

---

## 4. Step-by-step implementation

1. **Bootstrap** — Vite + React + Tailwind; Electron `main` loads dev URL or `file://` build.
2. **Overlay window** — `transparent: true`, `frame: false`, `alwaysOnTop`, `setContentProtection(true)`, optional `visibleOnFullScreen`.
3. **Click-through vs drag** — Default: `setIgnoreMouseEvents(true, { forward: true })`. Toggle **interaction mode** (shortcut) to drag/resize and click buttons.
4. **Shortcuts** — Register `globalShortcut` in main; send events to renderer via `webContents.send`.
5. **Audio** — Renderer: `getUserMedia` for mic; `getDisplayMedia` with `systemAudio` / `audio: true` for loopback (OS + browser constraints vary). Mix to mono PCM, chunk to main.
6. **STT** — Main: Deepgram live WebSocket; forward transcripts to renderer (`transcript:partial` / `final`).
7. **Context** — Zustand store: rolling transcript, last Q/A pairs, manual text field.
8. **AI** — Main: single structured prompt → JSON schema (type, short, detail, code, complexity, edgeCases, followUps). Debounce duplicate generations.
9. **Modes** — “Hint only”, “explain simpler” as system prompt variants (same endpoint, different instruction).
10. **Polish** — Copy button, multi-monitor (position per display `screen` API), language detection (Whisper/Deepgram language or fast LLM classify).

### Run locally

```bash
cp .env.example .env
# Prefer free AI: GROQ_API_KEY from https://console.groq.com
# Optional: OPENROUTER_API_KEY + LLM_MODEL=...:free, or OPENAI_API_KEY
npm install
npm run dev
```

- **Alt+Shift+O** — show/hide overlay  
- **Alt+Shift+I** — toggle click-through vs interact (drag, buttons)

---

## 5. Optimization strategies

- **STT**: Use Deepgram `interim_results` + endpointing; send **small** PCM frames (20–40 ms).
- **AI**: Keep a **token budget** (max output 400–600 tokens); one call that returns JSON, not chatty multi-step for common path.
- **Caching**: Hash last question text; skip regen if unchanged within N seconds.
- **GPU/CPU**: Disable background throttling for the hidden audio path if needed (`webPreferences.backgroundThrottling`).
- **Network**: Run STT and LLM in same region; reuse HTTP keep-alive where applicable.

---

## 6. Risks & limitations

- **Ethics / ToS**: Many employers prohibit undisclosed assistance; this repo is a technical scaffold — compliance is the user’s responsibility.
- **Stealth / screen share**: The overlay calls `setContentProtection(true)` (reapplied on show/load/move/resize) plus `setOpacity(1)` as a Windows workaround. Viewers of a screen share **usually** won’t see the window; **you still see it**. Not guaranteed for every OS/build or capture path (browser tab share, older Windows, some GPU drivers). Prefer putting the overlay on a **monitor you are not sharing** when possible.
- **System audio**: Loopback capture depends on OS, drivers, and whether the user shares “entire screen” with audio; there is no universal silent loopback without native modules or virtual cables on some setups.
- **Latency**: Sub-2s is achievable with streaming STT + a fast model, but not guaranteed on slow networks or large prompts.
- **Detection**: Click-through reduces obvious mouse focus; taskbar icon and process name still exist — rename binary and icon for lower visibility (still not undetectable).

---

## 7. Security

- Keep **API keys in main process** only (env + `dotenv`); never expose in preload beyond opaque IPC methods.
- Use `contextIsolation: true`, `nodeIntegration: false`, validate IPC payloads size/rate.
