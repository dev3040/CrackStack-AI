/**
 * Captures microphone PCM (linear16 mono) at the AudioContext sample rate.
 * Deepgram session must be started with the same sampleRate.
 */
export type PcmCapture = {
  sampleRate: number;
  stop: () => Promise<void>;
  /** True only when Meet/tab audio was actually mixed in */
  hadMeetTabAudio: boolean;
};

export type CaptureAudioOptions = {
  /** From `enumerateDevices`; omit for OS default input (follows Windows default when you plug headphones). */
  deviceId?: string;
  /** Linear gain before encoding (0.25–4). Compensates when browser capture doesn’t match what you hear. */
  micGain?: number;
  /** Same, for tab/Meet track when mixed. */
  tabGain?: number;
  /**
   * Headphones / earbuds: turns off echo cancellation and AGC on the mic so STT matches what you hear
   * more closely and avoids pumping. Recommended when Meet audio goes to your headset.
   */
  headsetMode?: boolean;
};

const clampGain = (g: number) =>
  Math.min(4, Math.max(0.25, Number.isFinite(g) ? g : 1));

function micTrackConstraints(
  deviceId: string | undefined,
  opts: { echoCancellation: boolean; autoGainControl: boolean },
): MediaTrackConstraints {
  const audio: MediaTrackConstraints = {
    channelCount: { ideal: 1 },
    echoCancellation: opts.echoCancellation,
    noiseSuppression: true,
    autoGainControl: opts.autoGainControl,
  };
  if (deviceId) {
    audio.deviceId = { exact: deviceId };
  }
  return audio;
}

export async function startMicPcmCapture(
  onPcm: (pcm: ArrayBuffer) => void,
  options: CaptureAudioOptions = {},
): Promise<PcmCapture> {
  const micGain = clampGain(options.micGain ?? 1);
  const headset = Boolean(options.headsetMode);

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: micTrackConstraints(options.deviceId, {
      echoCancellation: headset ? false : true,
      autoGainControl: headset ? false : true,
    }),
    video: false,
  });

  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);
  const gain = ctx.createGain();
  gain.gain.value = micGain;
  const bufferSize = 4096;
  const processor = ctx.createScriptProcessor(bufferSize, 1, 1);

  processor.onaudioprocess = (ev) => {
    const input = ev.inputBuffer.getChannelData(0);
    const pcm = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    onPcm(pcm.buffer.slice(0));
  };

  const silent = ctx.createGain();
  silent.gain.value = 0;
  source.connect(gain);
  gain.connect(processor);
  processor.connect(silent);
  silent.connect(ctx.destination);

  if (ctx.state === 'suspended') await ctx.resume();

  return {
    sampleRate: ctx.sampleRate,
    hadMeetTabAudio: false,
    stop: async () => {
      processor.disconnect();
      gain.disconnect();
      source.disconnect();
      silent.disconnect();
      await ctx.close();
      stream.getTracks().forEach((t) => t.stop());
    },
  };
}

/**
 * Mic + optional Google Meet / browser tab audio (headphones-safe).
 *
 * When `includeMeetTabAudio` is true, calls `getDisplayMedia`: choose the **Chrome tab**
 * where Meet is open and enable **“Share tab audio”** so remote voices are captured.
 * Tab capture is usually *not* attenuated by Windows speaker volume — use **tab gain** in Tools if it’s too loud vs your mic.
 *
 * When `systemAudioOnly` is true (with `includeMeetTabAudio`), the **microphone is not opened** — PCM is from
 * tab/system loopback only (e.g. interviewer on Meet, not your headset mic).
 */
export async function startMeetMixedPcmCapture(
  onPcm: (pcm: ArrayBuffer) => void,
  options: CaptureAudioOptions & {
    includeMeetTabAudio: boolean;
    systemAudioOnly?: boolean;
  },
): Promise<PcmCapture> {
  const micGain = clampGain(options.micGain ?? 1);
  const tabGain = clampGain(options.tabGain ?? 1);
  const headset = Boolean(options.headsetMode);
  const systemOnly =
    Boolean(options.includeMeetTabAudio) &&
    Boolean(options.systemAudioOnly);
  // Mixing Meet from tab + mic: echo cancellation on the mic fights the remote audio in the graph — keep it off.
  const echoOff = Boolean(options.includeMeetTabAudio) || headset;

  let micStream: MediaStream | null = null;
  if (!systemOnly) {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: micTrackConstraints(options.deviceId, {
        echoCancellation: !echoOff,
        autoGainControl: headset || options.includeMeetTabAudio ? false : true,
      }),
      video: false,
    });
  }

  let tabStream: MediaStream | null = null;
  let hadMeetTabAudio = false;

  if (options.includeMeetTabAudio) {
    const picked = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true,
    });
    hadMeetTabAudio = picked.getAudioTracks().length > 0;
    if (!hadMeetTabAudio) {
      picked.getTracks().forEach((t) => t.stop());
    } else {
      tabStream = picked;
    }
  }

  if (systemOnly && !tabStream) {
    if (micStream) {
      micStream.getTracks().forEach((tr) => tr.stop());
    }
    throw new Error(
      'System-audio-only mode needs tab or system loopback audio. Allow audio in the capture dialog, or turn off “System audio only”.',
    );
  }

  const ctx = new AudioContext();
  const bufferSize = 4096;
  const silent = ctx.createGain();
  silent.gain.value = 0;

  if (tabStream && systemOnly) {
    const tabSource = ctx.createMediaStreamSource(tabStream);
    const tabGainNode = ctx.createGain();
    tabGainNode.gain.value = tabGain;
    const processor = ctx.createScriptProcessor(bufferSize, 1, 1);
    processor.onaudioprocess = (ev) => {
      const input = ev.inputBuffer.getChannelData(0);
      const pcm = new Int16Array(input.length);
      for (let i = 0; i < input.length; i++) {
        const s = Math.max(-1, Math.min(1, input[i]));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      onPcm(pcm.buffer.slice(0));
    };
    tabSource.connect(tabGainNode);
    tabGainNode.connect(processor);
    processor.connect(silent);
    silent.connect(ctx.destination);

    if (ctx.state === 'suspended') await ctx.resume();

    return {
      sampleRate: ctx.sampleRate,
      hadMeetTabAudio: true,
      stop: async () => {
        processor.disconnect();
        tabGainNode.disconnect();
        tabSource.disconnect();
        silent.disconnect();
        await ctx.close();
        tabStream?.getTracks().forEach((tr) => tr.stop());
      },
    };
  }

  if (!micStream) {
    throw new Error('No microphone stream');
  }

  const micSource = ctx.createMediaStreamSource(micStream);
  const micGainNode = ctx.createGain();
  micGainNode.gain.value = micGain;

  if (tabStream) {
    const tabSource = ctx.createMediaStreamSource(tabStream);
    const tabGainNode = ctx.createGain();
    tabGainNode.gain.value = tabGain;
    // ScriptProcessor has one input with N channels; connect()’s inputIndex is the *node* input, not channel.
    // Merger exposes two mono inputs → one stereo output for the processor.
    const merger = ctx.createChannelMerger(2);
    const processor = ctx.createScriptProcessor(bufferSize, 2, 1);
    processor.onaudioprocess = (ev) => {
      const m = ev.inputBuffer.getChannelData(0);
      const t = ev.inputBuffer.getChannelData(1);
      const n = m.length;
      const pcm = new Int16Array(n);
      for (let i = 0; i < n; i++) {
        const sum = m[i] + t[i];
        const s = Math.max(-1, Math.min(1, sum));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      onPcm(pcm.buffer.slice(0));
    };
    micSource.connect(micGainNode);
    micGainNode.connect(merger, 0, 0);
    tabSource.connect(tabGainNode);
    tabGainNode.connect(merger, 0, 1);
    merger.connect(processor);
    processor.connect(silent);
    silent.connect(ctx.destination);

    if (ctx.state === 'suspended') await ctx.resume();

    return {
      sampleRate: ctx.sampleRate,
      hadMeetTabAudio: true,
      stop: async () => {
        processor.disconnect();
        merger.disconnect();
        micGainNode.disconnect();
        tabGainNode.disconnect();
        micSource.disconnect();
        tabSource.disconnect();
        silent.disconnect();
        await ctx.close();
        micStream.getTracks().forEach((tr) => tr.stop());
        tabStream?.getTracks().forEach((tr) => tr.stop());
      },
    };
  }

  const processor = ctx.createScriptProcessor(bufferSize, 1, 1);
  processor.onaudioprocess = (ev) => {
    const input = ev.inputBuffer.getChannelData(0);
    const pcm = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    onPcm(pcm.buffer.slice(0));
  };
  micSource.connect(micGainNode);
  micGainNode.connect(processor);
  processor.connect(silent);
  silent.connect(ctx.destination);

  if (ctx.state === 'suspended') await ctx.resume();

  return {
    sampleRate: ctx.sampleRate,
    hadMeetTabAudio,
    stop: async () => {
      processor.disconnect();
      micGainNode.disconnect();
      micSource.disconnect();
      silent.disconnect();
      await ctx.close();
      micStream.getTracks().forEach((tr) => tr.stop());
    },
  };
}
