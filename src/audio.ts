export class SimAudioEngine {
    private ctx: AudioContext | null = null;
    private fireBuffer: AudioBuffer | null = null;
    private lastHornMs = 0;
    private lastFireMs = 0;
    private enabled = false;

    public setEnabled(enabled: boolean): void {
        this.enabled = enabled;
        if (!enabled && this.ctx && this.ctx.state === "running") {
            void this.ctx.suspend().catch(() => {});
        } else if (enabled && this.ctx && this.ctx.state === "suspended") {
            void this.ctx.resume().catch(() => {});
        }
    }

    public unlock(): void {
        if (!this.enabled || typeof window === "undefined") return;
        if (!this.ctx) {
            const AudioCtx =
                window.AudioContext ||
                (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
            if (!AudioCtx) return;
            this.ctx = new AudioCtx();
        }
        if (this.ctx.state === "suspended") {
            void this.ctx.resume().catch(() => {});
        }
    }

    public playHorn(moodIndex: number, roadType: number): void {
        if (!this.enabled) return;
        const nowMs = performance.now();
        if (nowMs - this.lastHornMs < 220) return;

        this.unlock();
        if (!this.ctx || this.ctx.state !== "running") return;
        this.lastHornMs = nowMs;

        const baseFreq = roadType === 3 || roadType === 6 ? 320 : 390 + (moodIndex % 6) * 28;
        const doubleBeep = moodIndex % 3 === 0;

        this.triggerHornPulse(this.ctx.currentTime, baseFreq, 0.11);
        if (doubleBeep) {
            this.triggerHornPulse(this.ctx.currentTime + 0.14, baseFreq * 1.06, 0.09);
        }
    }

    private triggerHornPulse(startTime: number, freq: number, durationSec: number): void {
        const ctx = this.ctx;
        if (!ctx) return;

        const filter = ctx.createBiquadFilter();
        filter.type = "lowpass";
        filter.frequency.setValueAtTime(1400, startTime);

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.0001, startTime);
        gain.gain.exponentialRampToValueAtTime(0.045, startTime + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, startTime + durationSec);

        const osc1 = ctx.createOscillator();
        osc1.type = "triangle";
        osc1.frequency.setValueAtTime(freq, startTime);

        const osc2 = ctx.createOscillator();
        osc2.type = "sawtooth";
        osc2.frequency.setValueAtTime(freq * 1.26, startTime);

        osc1.connect(filter);
        osc2.connect(filter);
        filter.connect(gain);
        gain.connect(ctx.destination);

        osc1.start(startTime);
        osc2.start(startTime);
        osc1.stop(startTime + durationSec + 0.02);
        osc2.stop(startTime + durationSec + 0.02);
    }

    public playFireIgnite(): void {
        if (!this.enabled) return;
        const nowMs = performance.now();
        if (nowMs - this.lastFireMs < 800) return;

        this.unlock();
        if (!this.ctx || this.ctx.state !== "running") return;
        this.lastFireMs = nowMs;

        const ctx = this.ctx;
        const durationSec = 0.22;
        if (!this.fireBuffer || this.fireBuffer.sampleRate !== ctx.sampleRate) {
            const sampleCount = Math.floor(ctx.sampleRate * durationSec);
            const buffer = ctx.createBuffer(1, sampleCount, ctx.sampleRate);
            const data = buffer.getChannelData(0);
            const invDecay = 1 / (sampleCount * 0.35);
            for (let i = 0; i < sampleCount; i++) {
                data[i] = (Math.random() * 2 - 1) * Math.exp(-i * invDecay);
            }
            this.fireBuffer = buffer;
        }

        const src = ctx.createBufferSource();
        src.buffer = this.fireBuffer;

        const filter = ctx.createBiquadFilter();
        filter.type = "bandpass";
        filter.frequency.setValueAtTime(900, ctx.currentTime);
        filter.Q.setValueAtTime(1.2, ctx.currentTime);

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.04, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + durationSec);

        src.connect(filter);
        filter.connect(gain);
        gain.connect(ctx.destination);
        src.start();
    }
}
