// One mono input (selected/mixed by the capture graph); no audio outputs.
class RhythmRecallOnsets extends AudioWorkletProcessor {
  constructor() {
    super();
    this.env = .002;
    this.decay = Math.exp(-128 / sampleRate / .028);
    this.lastAttack = -Infinity;
    this.nextFrame = this.batchStart = undefined;
    this.count = this.power = 0;
    this.onsets = [];
  }

  process(inputs) {
    const pcm = inputs[0][0];
    if (!pcm?.length) return true; // No active input yet; never invent progress.
    if (this.nextFrame !== undefined && currentFrame !== this.nextFrame) throw new Error('Discontinuous input frames.');
    this.nextFrame = currentFrame + pcm.length;
    this.batchStart ??= currentFrame;

    for (let i = 0; i < pcm.length; i++) {
      this.power += pcm[i] * pcm[i];
      if (++this.count !== 128) continue;
      const rms = Math.sqrt(this.power / 128), frame = currentFrame + i + 1 - 128;
      if (!Number.isFinite(rms)) throw new Error('Invalid input samples.');
      if (rms > .009 && rms > this.env * 1.7 + .004 && frame - this.lastAttack > .045 * sampleRate) {
        this.lastAttack = frame;
        this.onsets.push(frame);
      }
      this.env = Math.max(rms, this.env * this.decay);
      this.count = this.power = 0;
    }

    // A partial window can still yield an onset at its first frame. Never
    // advertise that window as processed until it has been classified.
    const endFrame = this.nextFrame - this.count;
    if (endFrame - this.batchStart >= 512) {
      this.port.postMessage({startFrame:this.batchStart, endFrame, onsets:this.onsets});
      this.batchStart = endFrame;
      this.onsets = [];
    }
    return true;
  }
}

registerProcessor('rhythm-recall-onsets', RhythmRecallOnsets);
