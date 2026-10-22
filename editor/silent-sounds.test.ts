import {describe, expect, it} from 'vitest';
import {SilentSoundBank, type SoundClock} from './silent-sounds';

/** A clock that only moves when the test says so. */
const testClock = () => {
    let time = 0;
    let next = 0;
    const timers = new Map<number, {due: number; handler: () => void}>();
    const clock: SoundClock & {skip (ms: number): Promise<void>} = {
        now: () => time,
        setTimer: (handler, delayMs) => {
            timers.set(++next, {due: time + delayMs, handler});
            return next;
        },
        clearTimer: id => {
            timers.delete(id);
        },
        skip: async ms => {
            time += ms;
            for (const [id, timer] of [...timers].sort((a, b) => a[1].due - b[1].due)) {
                if (timer.due > time) continue;
                timers.delete(id);
                timer.handler();
            }
            await Promise.resolve();
        }
    };
    return clock;
};

const sprite = {sounds: [{soundId: 'short', rate: 1000, sampleCount: 150}, {soundId: 'long', rate: 1000, sampleCount: 450}]};

/** Plays the sound and reports whether it has ended. */
const play = (bank: SilentSoundBank, target: object, soundId: string) => {
    const state = {ended: false};
    bank.playSound(target, soundId).then(() => {
        state.ended = true;
    });
    return state;
};

describe('silent sounds', () => {
    it('end after their own length', async () => {
        const clock = testClock();
        const bank = new SilentSoundBank(clock, sprite);
        const target = {};
        const short = play(bank, target, 'short');
        const long = play(bank, target, 'long');
        await clock.skip(149);
        expect([short.ended, long.ended]).toEqual([false, false]);
        await clock.skip(1);
        expect([short.ended, long.ended]).toEqual([true, false]);
        await clock.skip(300);
        expect(long.ended).toBe(true);
    });

    it('play faster with a higher pitch, also when the pitch changes while playing', async () => {
        const clock = testClock();
        const bank = new SilentSoundBank(clock, sprite);
        const target = {soundEffects: {pitch: 120}};
        const octaveUp = play(bank, target, 'long');
        await clock.skip(225);
        expect(octaveUp.ended).toBe(true);
        // Half of the sound at normal speed (225 ms), then the other half an octave up (112.5 ms).
        const changed = play(bank, Object.assign(target, {soundEffects: {pitch: 0}}), 'long');
        await clock.skip(225);
        target.soundEffects.pitch = 120;
        bank.setEffects(target);
        await clock.skip(112);
        expect(changed.ended).toBe(false);
        await clock.skip(1);
        expect(changed.ended).toBe(true);
    });

    it('end the earlier playback when the same sound plays again', async () => {
        const clock = testClock();
        const bank = new SilentSoundBank(clock, sprite);
        const first = play(bank, {}, 'long');
        await clock.skip(100);
        const second = play(bank, {}, 'long');
        await clock.skip(0);
        expect([first.ended, second.ended]).toEqual([true, false]);
        await clock.skip(450);
        expect(second.ended).toBe(true);
    });

    it('end when stopped, only for the target that played them', async () => {
        const clock = testClock();
        const bank = new SilentSoundBank(clock, sprite);
        const cat = {};
        const dog = {};
        const catSound = play(bank, cat, 'short');
        const dogSound = play(bank, dog, 'long');
        bank.stop(dog, 'short');
        bank.stopAllSounds(cat);
        await clock.skip(0);
        expect([catSound.ended, dogSound.ended]).toEqual([true, false]);
        bank.stopAllSounds();
        await clock.skip(0);
        expect(dogSound.ended).toBe(true);
    });

    it('take no time for a sound that is missing or has no length', async () => {
        const clock = testClock();
        const bank = new SilentSoundBank(clock, {sounds: [{soundId: 'empty'}]});
        const missing = play(bank, {}, 'nothing');
        const empty = play(bank, {}, 'empty');
        await clock.skip(0);
        expect([missing.ended, empty.ended]).toEqual([true, true]);
    });
});
