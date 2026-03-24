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

export async function startMicPcmCapture(
  onPcm: (pcm: ArrayBuffer) => void,
): Promise<PcmCapture> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
    video: false,
  });

  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);
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
  source.connect(processor);
  processor.connect(silent);
  silent.connect(ctx.destination);

  if (ctx.state === 'suspended') await ctx.resume();

  return {
    sampleRate: ctx.sampleRate,
    hadMeetTabAudio: false,
    stop: async () => {
      processor.disconnect();
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
 * Headphones are fine — this taps the tab’s audio, not the room mic.
 */
export async function startMeetMixedPcmCapture(
  onPcm: (pcm: ArrayBuffer) => void,
  options: { includeMeetTabAudio: boolean },
): Promise<PcmCapture> {
  const micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
    video: false,
  });

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

  const ctx = new AudioContext();
  const micSource = ctx.createMediaStreamSource(micStream);
  const bufferSize = 4096;
  const silent = ctx.createGain();
  silent.gain.value = 0;

  if (tabStream) {
    const tabSource = ctx.createMediaStreamSource(tabStream);
    const processor = ctx.createScriptProcessor(bufferSize, 2, 1);
    processor.onaudioprocess = (ev) => {
      const m = ev.inputBuffer.getChannelData(0);
      const t = ev.inputBuffer.getChannelData(1);
      const n = m.length;
      const pcm = new Int16Array(n);
      for (let i = 0; i < n; i++) {
        const s = Math.max(-1, Math.min(1, (m[i] + t[i]) * 0.47));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      onPcm(pcm.buffer.slice(0));
    };
    micSource.connect(processor, 0, 0);
    tabSource.connect(processor, 0, 1);
    processor.connect(silent);
    silent.connect(ctx.destination);

    if (ctx.state === 'suspended') await ctx.resume();

    return {
      sampleRate: ctx.sampleRate,
      hadMeetTabAudio: true,
      stop: async () => {
        processor.disconnect();
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
  micSource.connect(processor);
  processor.connect(silent);
  silent.connect(ctx.destination);

  if (ctx.state === 'suspended') await ctx.resume();

  return {
    sampleRate: ctx.sampleRate,
    hadMeetTabAudio,
    stop: async () => {
      processor.disconnect();
      micSource.disconnect();
      silent.disconnect();
      await ctx.close();
      micStream.getTracks().forEach((tr) => tr.stop());
    },
  };
}
