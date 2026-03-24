import WebSocket from 'ws';
import type { TranscriptEvent } from '../../shared/types';

export type { TranscriptEvent };

type Handlers = {
  onTranscript: (ev: TranscriptEvent) => void;
  onError: (err: Error) => void;
  onClose: () => void;
};

/**
 * Deepgram live streaming over WebSocket.
 * Sends linear16 mono PCM at sampleRate (default 16kHz).
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

    const params = new URLSearchParams({
      encoding: 'linear16',
      sample_rate: String(this.sampleRate),
      channels: '1',
      model: 'nova-2',
      interim_results: 'true',
      endpointing: '400',
      utterance_end_ms: '1000',
    });

    const url = `wss://api.deepgram.com/v1/listen?${params.toString()}`;
    this.ws = new WebSocket(url, {
      headers: { Authorization: `Token ${this.apiKey}` },
    });

    this.ws.on('message', (data) => {
      try {
        const payload = JSON.parse(data.toString()) as {
          type?: string;
          channel?: {
            alternatives?: Array<{ transcript?: string }>;
          };
          is_final?: boolean;
          speech_final?: boolean;
        };
        if (payload.type !== 'Results') return;
        const text = payload.channel?.alternatives?.[0]?.transcript?.trim() ?? '';
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
