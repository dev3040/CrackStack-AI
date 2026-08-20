/// <reference types="vite/client" />

import type { CopilotApi } from '../electron/preload';

declare global {
  interface Window {
    copilotApi: CopilotApi;
  }
}

export {};
