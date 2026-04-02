# CrackStack-AI

A transparent **Electron overlay** for technical interview prep and live sessions: **speech-to-text** (optional), **structured AI answers** (short summary, detail, code, complexity, hints), and a separate **Chat with AI** thread. Keys stay in the **main process**; the UI is **React + Tailwind + Zustand**.

> **Disclaimer:** Many employers forbid undisclosed assistance in real interviews. This project is a **technical/educational tool**. You are responsible for following laws, contracts, and interview rules.

---

## Demo


https://github.com/user-attachments/assets/d21f0978-bd9f-4726-816c-761ee3d54b6e




<img width="995" height="360" alt="image" src="https://github.com/user-attachments/assets/cffe450a-f5b0-45a2-8252-516472239bb4" />

---

## Features

| Area | What you get |
|------|----------------|
| **Overlay** | Frameless, always-on-top, dark UI, resizable, wide layout for answers |
| **Opacity** | **Window opacity** slider under the title bar (and in **Tools**): 15–100% via Electron `setOpacity`; persisted in `localStorage` |
| **Stealth** | Click-through by default (`Interact` / **Alt+Shift+I** to click); optional **hide from screen capture**; **hidden from Windows taskbar** by default |
| **STT** | Microphone → **Deepgram** live streaming (optional `DEEPGRAM_API_KEY`) |
| **Meet / tab audio** | Optional: share the **Chrome tab** with Meet and enable **Share tab audio** so remote voices are captured while using headphones |
| **Session AI** | Classifies question type (DSA, system design, coding, etc.) and returns JSON → **Code** (full solutions via a two-step pipeline when needed), **Short**, **Detail**, edge cases, follow-ups |
| **Modes** | Full answer, Hint only, Explain simpler |
| **Chat** | Bottom **Chat with AI** for freeform Q&A (separate from session transcript) |
| **Tools drawer** | Slide-out panel: STT, modes, manual paste, transcript, screen-share shield, Meet tab option, clear session / clear chat |
| **Clear** | **Clear conversation** (session transcript + answer + manual notes) and **Clear chat** |

---

## Tech stack

- **Desktop:** Electron 33  
- **UI:** React 18, Vite 5, Tailwind CSS 3, Zustand  
- **Main:** Node (TypeScript) — `ws` (Deepgram), `openai` package (Groq / OpenRouter / OpenAI-compatible APIs)  
- **STT:** Deepgram WebSocket (live, linear16 PCM)

---

## Prerequisites

- **Node.js** 18+ (includes `npm`)  
- **API keys** (at least one AI provider — Groq free tier is supported out of the box)

---

## Quick start

```bash
git clone <your-repo-url>
cd interview-copilot   # or your folder name
cp .env.example .env
```

Edit `.env` and set at least **`GROQ_API_KEY`** (see [Environment variables](#environment-variables)).

```bash
npm install
npm run dev
```

Wait for Vite + `tsc` to finish; Electron should open the overlay.

### Global shortcuts

| Shortcut | Action |
|----------|--------|
| **Alt+Shift+O** | Show / hide the overlay window |
| **Alt+Shift+I** | Toggle **click-through** vs **Interact** (mouse hits the UI; drag/resize/buttons) |

Use **Interact** before clicking **Tools**, checkboxes, chat, or **Clear conversation**.

---

## Environment variables

Copy `.env.example` → `.env`. Common options:

| Variable | Required | Description |
|----------|----------|-------------|
| `GROQ_API_KEY` | One AI key required* | [Groq console](https://console.groq.com) — free tier, fast inference |
| `OPENROUTER_API_KEY` | * | [OpenRouter](https://openrouter.ai); use with `LLM_MODEL` e.g. `...:free` |
| `OPENAI_API_KEY` | * | Paid OpenAI; used if Groq/OpenRouter not set |
| `LLM_MODEL` | No | Override model for the active provider |
| `LLM_MAX_TOKENS` | No | Cap for structured + code path (defaults tuned for coding) |
| `LLM_CODE_MAX_TOKENS` | No | Max tokens for the **plain-text code** step (second call) |
| `LLM_CHAT_MAX_TOKENS` | No | Max tokens for **Chat with AI** (default 3072) |
| `DEEPGRAM_API_KEY` | No | Enables live STT; without it, use manual paste in Tools |
| `DEEPGRAM_MODEL` | No | Default `nova-3` (accuracy). For classic multi-speaker calls try `nova-2-meeting` |
| `DEEPGRAM_LANGUAGE` | No | Default `en`; use `multi` only with a multilingual model (see Deepgram docs) |
| `DEEPGRAM_ENDPOINTING` | No | Ms silence before phrase end (default `550`; raise if words get cut off) |
| `DEEPGRAM_KEYTERMS` | No | Comma-separated jargon / names — boosts recognition (Nova-3: keyterms; Nova-2: keywords) |
| `DEEPGRAM_SMART_FORMAT` | No | Set `false` if formatted numbers/dates look wrong in transcripts |
| `CONTENT_PROTECTION` | No | `false` disables “hide from screen capture” (debug) |
| `SHOW_IN_TASKBAR` | No | `true` shows the app on the **Windows taskbar** (default: hidden) |

\*You need **at least one** of: `GROQ_API_KEY`, `OPENROUTER_API_KEY`, or `OPENAI_API_KEY`. Priority is: Groq → OpenRouter → OpenAI.

---

## Using the app

### Main layout

- **Window opacity** — Bar directly under the title: drag **Ghost → Solid** to make the whole overlay more see-through or **100%** for easiest reading (chat + answers). Uses **Interact** mode to drag the slider when click-through is on.
- **Live** — Current STT line; red dot when STT is running. **Clear conversation** clears session transcript, manual notes, structured answer, and related state (does not stop STT by itself).
- **Center** — Large **session answer** (interview-style structured card).
- **Bottom** — **Chat with AI** (Enter to send, Shift+Enter for newline). **Clear chat** in the chat header clears only that thread.

### Tools drawer

Click **Tools** in the title bar:

- AI / Deepgram status  
- **Hide from screen share** (content protection)  
- **Capture Google Meet / tab audio** — when starting STT, pick the Meet tab and enable **Share tab audio**  
- Start/stop STT, **Run AI on last text**, **Copy session answer**  
- **Full / Hint / Simpler**  
- Manual textarea + **Append & run AI**  
- Session transcript preview  
- **Clear session** / **Clear chat only**

### Headphones + Google Meet

The mic does **not** hear audio that only plays in your headset. With **Meet tab audio** enabled, you share the browser tab’s audio so the interviewer’s voice is included in STT (along with your mic).

---

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Vite dev server + `tsc --watch` for Electron + launch Electron |
| `npm run build` | Production bundle: `dist/renderer` + `dist-electron/electron` |
| `npm run preview` | Build then run Electron against built files |
| `npm start` | Run Electron (expects `dist-electron` + built renderer already present) |

---

## Project structure

```
├── electron/
│   ├── main.ts                 # Window, shortcuts, IPC, content protection, taskbar
│   ├── preload.ts              # contextBridge → window.copilotApi
│   └── services/
│       ├── aiPipeline.ts       # Structured answers, two-step coding, chat completion
│       └── deepgramLive.ts     # Deepgram live WebSocket client
├── shared/
│   └── types.ts                # Shared TS types (renderer + main)
├── src/
│   ├── App.tsx                 # Layout, STT wiring, chat, tools drawer
│   ├── audio/capture.ts        # Mic PCM; optional Meet/tab mix
│   ├── components/             # TitleBar, AnswerCard, ChatDock, ToolsDrawer
│   └── store/useCopilotStore.ts
├── index.html
├── vite.config.ts
├── tsconfig.json               # Renderer
├── tsconfig.electron.json      # Main + shared → dist-electron/
├── ARCHITECTURE.md             # Deeper design notes, risks, security
└── README.md                   # This file
```

Entry point for Electron: `package.json` → `"main": "dist-electron/electron/main.js"`.

---

## Architecture

High level:

1. **Renderer** captures audio (mic ± tab), sends PCM to **main** via IPC.  
2. **Main** streams PCM to **Deepgram**, pushes transcripts to the renderer.  
3. On phrase end, renderer triggers **structured generation** (`ai:generate`) in main — Groq/OpenRouter/OpenAI with JSON (and a dedicated **code-only** completion when a coding task is detected).  
4. **Chat** uses `ai:chat` with conversation history (last ~28 turns).

More detail: **[ARCHITECTURE.md](./ARCHITECTURE.md)** (Electron vs Tauri, data flow, optimizations, limitations).

---

## Security

- API keys are read from **`.env`** in the **main process** only.  
- Preload exposes a **fixed IPC API** — no raw `process.env` in the renderer.  
- `contextIsolation: true`, `nodeIntegration: false` on the overlay `BrowserWindow`.

---

## Limitations & troubleshooting

- **Screen capture exclusion** is best-effort (`setContentProtection`); not guaranteed for every OS, GPU, or conferencing app. Prefer a **monitor you are not sharing**.  
- **Chat not responding:** Ensure `ai:chat` is registered (current `main.ts`); fully **restart** Electron after pulling changes.  
- **Truncated code:** Coding path uses a two-step flow; raise `LLM_MAX_TOKENS` / `LLM_CODE_MAX_TOKENS` or use a larger Groq model via `LLM_MODEL`.  
- **STT errors:** Check `DEEPGRAM_API_KEY`, mic permissions, and (for tab audio) that **Share tab audio** was checked in the picker.  
- **Taskbar:** Set `SHOW_IN_TASKBAR=true` if you need the icon while debugging.

---
