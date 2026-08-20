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
 *
 * `channels`: 1 for a single source (mic-only or tab-only). 2 when the renderer streams
 * mic + tab as separate interleaved channels — Deepgram then diarizes by channel instead
 * of us pre-mixing (which used to clip and blur overlapping speech into mush).
 */
function buildListenQueryParams(
  sampleRate: number,
  channels: 1 | 2,
  extraKeyterms: string[],
): URLSearchParams {
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
    channels: String(channels),
    model,
    language,
    interim_results: 'true',
    punctuate: 'true',
    endpointing,
    utterance_end_ms: utteranceEnd,
  });

  if (channels > 1) {
    // Tells Deepgram the PCM is interleaved per-channel audio to transcribe independently,
    // rather than a single mixed source — this is what lets us tell "you" from "interviewer".
    params.set('multichannel', 'true');
  }

  if (smartFormat) {
    params.set('smart_format', 'true');
  } else {
    params.set('smart_format', 'false');
  }

  appendVocabularyBoosts(params, model, extraKeyterms);

  return params;
}

/** Nova-3+: keyterm. Nova-2 / Enhanced / Base: keywords with optional :intensifier. */
function appendVocabularyBoosts(
  params: URLSearchParams,
  model: string,
  extraKeyterms: string[],
): void {
  const raw = envTrim('DEEPGRAM_KEYTERMS');
  const envTerms = raw
    ? raw
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
    : [];

  // Merge static env list with per-session terms pulled from resume/JD, case-insensitive dedupe.
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const t of [...envTerms, ...extraKeyterms]) {
    const key = t.toLowerCase();
    if (!t || seen.has(key)) continue;
    seen.add(key);
    terms.push(t);
    if (terms.length >= 80) break;
  }
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
  private readonly channels: 1 | 2;
  private readonly extraKeyterms: string[];

  constructor(
    apiKey: string,
    handlers: Handlers,
    sampleRate = 16_000,
    channels: 1 | 2 = 1,
    extraKeyterms: string[] = [],
  ) {
    this.apiKey = apiKey;
    this.handlers = handlers;
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.extraKeyterms = extraKeyterms;
  }

  connect(): void {
    if (this.ws) return;

    const params = buildListenQueryParams(
      this.sampleRate,
      this.channels,
      this.extraKeyterms,
    );
    const url = `wss://api.deepgram.com/v1/listen?${params.toString()}`;
    this.ws = new WebSocket(url, {
      headers: { Authorization: `Token ${this.apiKey}` },
    });

    const multichannel = this.channels > 1;

    this.ws.on('message', (data) => {
      try {
        const payload = JSON.parse(data.toString()) as {
          type?: string;
          channel?: {
            alternatives?: Alt[];
          };
          channel_index?: number[];
          is_final?: boolean;
          speech_final?: boolean;
        };
        if (payload.type !== 'Results') return;
        const text = pickBestTranscript(payload.channel?.alternatives);
        if (!text) return;

        // Our own capture convention: channel 0 = your mic, channel 1 = tab/interviewer audio.
        const channelIdx = payload.channel_index?.[0];
        const source: 'mic' | 'tab' | undefined =
          multichannel && channelIdx !== undefined
            ? channelIdx === 0
              ? 'mic'
              : 'tab'
            : undefined;

        this.handlers.onTranscript({
          text,
          isFinal: Boolean(payload.is_final),
          speechFinal: Boolean(payload.speech_final),
          source,
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
