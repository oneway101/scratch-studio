// Sounds in the grading VM. It has no audio engine, so without this a sprite has no sound bank
// and "play sound until done" ends at once. This bank plays nothing but keeps scratch-audio's
// SoundBank timing: a sound ends after its length (slower or faster with the pitch effect),
// playing a sound again ends the earlier playback, and stopping ends it.

type Target = any;

/** Project time and timers: the grading VM's clock. */
export interface SoundClock {
    now (): number;
    setTimer (handler: () => void, delayMs: number): number;
    clearTimer (id: number): void;
}

interface Playback {
    target: Target;
    /** Length of the sound in seconds. */
    length: number;
    /** Seconds of the sound played at `since`. */
    position: number;
    since: number;
    /** Playback rate from the pitch effect. */
    ratio: number;
    timer: number;
    finish: () => void;
}

/** scratch-audio's pitch effect: 10 steps a semitone. */
const pitchRatio = (target: Target): number => 2 ** (Number(target.soundEffects?.pitch ?? 0) / 10 / 12);

/** In the place of scratch-audio's SoundBank, for the methods scratch-vm calls while a project runs. */
export class SilentSoundBank {
    private playing = new Map<string, Playback>();

    constructor (private clock: SoundClock, private sprite: {sounds: {soundId: string; rate?: number; sampleCount?: number}[]}) {}

    /** Resolves when the sound ends or is stopped. */
    playSound (target: Target, soundId: string): Promise<void> {
        // scratch-audio has one player per sound: playing it again stops the earlier playback.
        this.end(soundId);
        const sound = this.sprite.sounds.find(candidate => candidate.soundId === soundId);
        const length = sound && sound.rate ? Number(sound.sampleCount) / sound.rate : 0;
        return new Promise(resolve => {
            const playback: Playback = {target, length, position: 0, since: this.clock.now(), ratio: pitchRatio(target), timer: 0, finish: resolve};
            this.playing.set(soundId, playback);
            this.schedule(soundId, playback);
        });
    }

    stop (target: Target, soundId: string) {
        if (this.playing.get(soundId)?.target === target) this.end(soundId);
    }

    stopAllSounds (target?: Target) {
        for (const [soundId, playback] of this.playing) {
            if (target === undefined || playback.target === target) this.end(soundId);
        }
    }

    /** The target's effects changed: a new pitch changes how long the rest of the sound takes. */
    setEffects (target: Target) {
        const now = this.clock.now();
        for (const [soundId, playback] of this.playing) {
            if (playback.target !== target) continue;
            playback.position += (now - playback.since) / 1000 * playback.ratio;
            playback.since = now;
            playback.ratio = pitchRatio(target);
            this.clock.clearTimer(playback.timer);
            this.schedule(soundId, playback);
        }
    }

    dispose () {
        for (const playback of this.playing.values()) this.clock.clearTimer(playback.timer);
        this.playing.clear();
    }

    private schedule (soundId: string, playback: Playback) {
        const left = Math.max(0, playback.length - playback.position) / playback.ratio * 1000;
        playback.timer = this.clock.setTimer(() => this.end(soundId), left);
    }

    private end (soundId: string) {
        const playback = this.playing.get(soundId);
        if (!playback) return;
        this.clock.clearTimer(playback.timer);
        this.playing.delete(soundId);
        playback.finish();
    }
}
