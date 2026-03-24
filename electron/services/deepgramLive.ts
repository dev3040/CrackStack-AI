import WebSocket from 'ws';
import type { TranscriptEvent } from '../../shared/types';

export type { TranscriptEvent };

type Handlers = {
  onTranscript: (ev: TranscriptEvent) => void;
  onError: (err: Error) => void;
  onClose: () => void;
};

type Alt = { transcript?: string; confidence?: number };

function envTrim(key: string): string | undefined {
  const v = process.env[key]?.trim();
  return v && v.length > 0 ? v : undefined;
}

/**
 * Defaults tuned for video calls (Meet, Zoom, etc.): Nova-3 accuracy, explicit English,
 * slightly longer endpointing so words aren’t cut on choppy VoIP.
 */
function buildListenQueryParams(sampleRate: number): URLSearchParams {
  const model = envTrim('DEEPGRAM_MODEL') ?? 'nova-3';
  const language = envTrim('DEEPGRAM_LANGUAGE') ?? 'en';

  const endpointing = envTrim('DEEPGRAM_ENDPOINTING') ?? '550';
  const utteranceEnd =
    envTrim('DEEPGRAM_UTTERANCE_END_MS') ?? '1300';

  const smartFormatRaw = envTrim('DEEPGRAM_SMART_FORMAT');
  const smartFormat =
    smartFormatRaw === undefined
      ? true
      : !/^(0|false|no|off)$/i.test(smartFormatRaw);

  const params = new URLSearchParams({
    encoding: 'linear16',
    sample_rate: String(sampleRate),
    channels: '1',
    model,
    language,
    interim_results: 'true',
    punctuate: 'true',
    endpointing,
    utterance_end_ms: utteranceEnd,
  });

  if (smartFormat) {
    params.set('smart_format', 'true');
  } else {
    params.set('smart_format', 'false');
  }

  appendVocabularyBoosts(params, model);

  return params;
}

/** Nova-3+: keyterm. Nova-2 / Enhanced / Base: keywords with optional :intensifier. */
function appendVocabularyBoosts(params: URLSearchParams, model: string): void {
  const raw = envTrim('DEEPGRAM_KEYTERMS');
  if (!raw) return;

  const terms = raw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 80);
  if (terms.length === 0) return;

  const useKeyterm = /^nova-3/i.test(model) || /^flux-/i.test(model);

  if (useKeyterm) {
    for (const t of terms) {
      params.append('keyterm', t);
    }
    return;
  }

  for (const t of terms) {
    const hasBoost = /:\s*[\d.-]+$/i.test(t);
    const kw = hasBoost ? t : `${t}:1.5`;
    params.append('keywords', kw);
  }
}

function pickBestTranscript(alternatives: Alt[] | undefined): string {
  if (!alternatives?.length) return '';
  let best = alternatives[0];
  let bestConf = best.confidence ?? -1;
  for (let i = 1; i < alternatives.length; i++) {
    const a = alternatives[i];
    const c = a.confidence ?? -1;
    if (c > bestConf) {
      best = a;
      bestConf = c;
    }
  }
  return best.transcript?.trim() ?? '';
}

/**
 * Deepgram live streaming over WebSocket.
 * Sends linear16 mono PCM at sampleRate (browser AudioContext is often 48 kHz).
 * @see https://developers.deepgram.com/docs/getting-started-with-live-streaming-audio
 */
export class DeepgramLiveSession {
  private ws: WebSocket | null = null;
  private readonly apiKey: string;
  private readonly handlers: Handlers;
  private readonly sampleRate: number;

  constructor(apiKey: string, handlers: Handlers, sampleRate = 16_000) {
    this.apiKey = apiKey;
    this.handlers = handlers;
    this.sampleRate = sampleRate;
  }

  connect(): void {
    if (this.ws) return;

    const params = buildListenQueryParams(this.sampleRate);
    const url = `wss://api.deepgram.com/v1/listen?${params.toString()}`;
    this.ws = new WebSocket(url, {
      headers: { Authorization: `Token ${this.apiKey}` },
    });

    this.ws.on('message', (data) => {
      try {
        const payload = JSON.parse(data.toString()) as {
          type?: string;
          channel?: {
            alternatives?: Alt[];
          };
          is_final?: boolean;
          speech_final?: boolean;
        };
        if (payload.type !== 'Results') return;
        const text = pickBestTranscript(payload.channel?.alternatives);
        if (!text) return;
        this.handlers.onTranscript({
          text,
          isFinal: Boolean(payload.is_final),
          speechFinal: Boolean(payload.speech_final),
        });
      } catch {
        /* ignore parse noise */
      }
    });

    this.ws.on('error', (err) => {
      this.handlers.onError(err instanceof Error ? err : new Error(String(err)));
    });

    this.ws.on('close', () => {
      this.ws = null;
      this.handlers.onClose();
    });
  }

  sendPcm(pcm: Buffer): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(pcm);
    }
  }

  close(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'CloseStream' }));
    }
    this.ws?.close();
    this.ws = null;
  }
}
