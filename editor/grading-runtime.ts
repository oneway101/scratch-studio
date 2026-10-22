// The runtime dynamic checks run in: a second VM with a renderer on a canvas nobody sees.
// It is made for one run and thrown away, so the student's editor is never touched.
import VM from 'scratch-vm';
import Renderer from 'scratch-render';
import {BitmapAdapter} from '@turbowarp/scratch-svg-renderer';
import dispatch from 'scratch-vm/src/dispatch/central-dispatch';
import Timer from 'scratch-vm/src/util/timer';
import storage from '@gui/lib/storage';
import type {CreateRuntime, GradingRuntime, Reading} from '../grader/index';
import {variants} from '../grader/compare';
import {lockExtensions} from './extensions';
import {SilentSoundBank} from './silent-sounds';

const STAGE_WIDTH = 480;
const STAGE_HEIGHT = 360;

type Target = any;

/**
 * How much faster than real time project time runs inside a frame of the grading VM.
 * A frame lets scripts run for 75% of the frame (25 ms at 30 frames a second), and a script that
 * waits keeps checking its timer for all of that. With the frame's own time sped up, that work
 * time takes 25 / FRAME_SPEEDUP ms of real time, and a wait still ends at the same point in the
 * frame as on the student's screen. The cost: the grading VM is like a computer FRAME_SPEEDUP
 * times slower, so a frame with more than 25 / FRAME_SPEEDUP ms of real work takes longer than
 * one frame of project time.
 */
const FRAME_SPEEDUP = 5;

/**
 * Project time for the grading VM. Nobody watches the grading VM, so it does not wait for the
 * wall clock between frames: frames run back to back and the clock skips the idle time between
 * them. Inside a frame the clock runs FRAME_SPEEDUP times real speed, so loops that budget time
 * (the sequencer's work time, warp-mode custom blocks) still end.
 *
 * scratch-vm reads time in three ways: `runtime.currentMSecs` (wait, the timer block, compiled
 * scripts), `new Timer()` whose default clock is the page-wide `Timer.nowObj` (glide, music), and
 * the page's `setTimeout` (say or think for secs). The last two are shared with the student's VM,
 * so they point at this clock only while `run` calls into the grading VM. That code is
 * synchronous, so the student's VM never runs in between.
 */
class SkipClock {
    /** Project time when the current `run` started, or now when nothing is running. */
    time = Date.now();
    private runStarted: number | null = null;
    private timers = new Map<number, {due: number; handler: () => void}>();
    private nextTimer = 0;

    now (): number {
        return this.runStarted === null ? this.time : this.time + (performance.now() - this.runStarted) * FRAME_SPEEDUP;
    }

    /** Calls into the grading VM with this clock as the page's clock. Not reentrant. */
    run<T> (work: () => T): T {
        const saved = {setTimeout: window.setTimeout, clearTimeout: window.clearTimeout};
        activeClock = this;
        window.setTimeout = ((handler: () => void, delay = 0) => this.setTimer(handler, delay)) as typeof window.setTimeout;
        window.clearTimeout = (id => {
            if (!this.timers.delete(id as number)) saved.clearTimeout.call(window, id);
        }) as typeof window.clearTimeout;
        this.runStarted = performance.now();
        try {
            return work();
        } finally {
            this.time = this.now();
            this.runStarted = null;
            Object.assign(window, saved);
            activeClock = null;
        }
    }

    /** Moves the clock forward (never back) and runs the timers that are due, in order. */
    skipTo (time: number) {
        this.time = Math.max(this.time, time);
        for (;;) {
            let next: [number, {due: number; handler: () => void}] | undefined;
            for (const entry of this.timers) if (entry[1].due <= this.time && (!next || entry[1].due < next[1].due)) next = entry;
            if (!next) return;
            this.timers.delete(next[0]);
            this.run(next[1].handler);
        }
    }

    clear () {
        this.timers.clear();
    }

    setTimer (handler: () => void, delay: number): number {
        // Far above the page's own timer ids, so clearing one of them never clears ours.
        const id = 2 ** 30 + this.nextTimer++;
        this.timers.set(id, {due: this.now() + Math.max(0, Number(delay) || 0), handler});
        return id;
    }

    clearTimer (id: number) {
        this.timers.delete(id);
    }
}

let activeClock: SkipClock | null = null;
const pageClock = Object.getOwnPropertyDescriptor(Timer, 'nowObj')!.get!;
Object.defineProperty(Timer, 'nowObj', {
    configurable: true,
    get: () => activeClock ?? pageClock.call(Timer)
});

/** Lets promise callbacks (say for secs, music) run between frames without the 4 ms setTimeout delay. */
const nextTask = () => new Promise<void>(resolve => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => resolve();
    channel.port2.postMessage(null);
});

const sayText = (target: Target): string => {
    const state = target.getCustomState('Scratch.looks');
    return state && state.text != null ? String(state.text) : '';
};

/**
 * Records the notes the music extension plays: the MIDI note and its length in beats. Drums are
 * left out. Hooked below the block, so it works without an audio engine and for compiled scripts.
 */
const recordNotes = (runtime: any): {notes: number[]; beats: number[]} => {
    const played = {notes: [] as number[], beats: [] as number[]};
    const music = runtime.ext_music;
    if (!music) return played;
    const playNote = music._playNote.bind(music);
    music._playNote = (util: any, note: number, durationSec: number) => {
        const tempo = runtime.getTargetForStage().tempo;
        played.notes.push(Math.round(note));
        played.beats.push(Math.round(durationSec * tempo / 60 * 100) / 100);
        return playNote(util, note, durationSec);
    };
    return played;
};

const costumeName = (target: Target): string | undefined => target.getCostumes()[target.currentCostume]?.name;

/**
 * scratch-vm keeps one page-wide service table (central dispatch). A new VM takes over the
 * "runtime" and "extensions" services, and its extensions take names like "extension_0_music"
 * that the student's VM also uses. Left like that, an extension the student adds after grading
 * would register with the grading VM that is already gone. So the table is put back as soon as
 * the grading VM has loaded: its blocks already hold their extension objects by then.
 */
let loading: Promise<unknown> = Promise.resolve();
const withOwnServices = <T>(work: () => Promise<T>): Promise<T> => {
    // One load at a time: a load still going after a timeout, or a second grade request, would
    // otherwise save a table that already holds the other grading VM's services and put it back.
    const next = loading.then(async () => {
        const saved = {...dispatch.services};
        try {
            return await work();
        } finally {
            dispatch.services = saved;
        }
    });
    loading = next.catch(() => {});
    return next;
};

export const createGradingRuntime = (sb3: ArrayBuffer): CreateRuntime => () => withOwnServices(async () => {
    // Set up like the student's VM (reducers/vm.js, containers/stage.jsx): 30 frames a second,
    // and the bitmap adapter, without which projects with bitmap costumes do not load.
    // TurboWarp's project options (framerate and others saved in the project) load with the project.
    const vm = new VM();
    vm.setCompatibilityMode(true);
    lockExtensions(vm);
    vm.attachStorage(storage);
    vm.attachV2BitmapAdapter(new BitmapAdapter());
    // A renderer is required: without one, loops do not wait for redraws and run far too fast,
    // and "touching" checks have nothing to test against (docs/spike.md).
    const canvas = document.createElement('canvas');
    canvas.width = STAGE_WIDTH;
    canvas.height = STAGE_HEIGHT;
    const renderer = new Renderer(canvas);
    vm.attachRenderer(renderer);
    // No audio engine: the grading VM is silent.
    const clock = new SkipClock();
    let disposed = false;
    const dispose = () => {
        if (disposed) return;
        disposed = true;
        clock.run(() => vm.stopAll());
        clock.clear();
        vm.quit();
        renderer.gl?.getExtension('WEBGL_lose_context')?.loseContext();
    };
    try {
        await vm.loadProject(sb3.slice(0));
    } catch (e) {
        dispose();
        throw e;
    }
    const runtime = vm.runtime;
    const played = recordNotes(runtime);
    // The frame loop is ours (advance), not vm.start()'s interval. Frame length as the project
    // sets it (TurboWarp's framerate option; 0 means the screen's rate, taken as 60).
    clock.time = Date.now();
    runtime.currentStepTime = 1000 / (runtime.frameLoop.framerate || 60);
    runtime.updateCurrentMSecs = () => {
        runtime.currentMSecs = clock.now();
    };
    runtime.updateCurrentMSecs();
    runtime.ioDevices.clock.resetProjectTimer();
    // The sequencer's work time per frame, in the same sped-up time.
    runtime.sequencer.timer = new Timer(clock);
    // Silent sounds that still take their time (no audio engine, so sprites have no sound bank).
    // The audio engine also gives each sound its soundId; without one every sound would be the first.
    let soundIds = 0;
    for (const sprite of new Set<Target>(runtime.targets.map((target: Target) => target.sprite))) {
        for (const sound of sprite.sounds) sound.soundId ??= `silent-${soundIds++}`;
        sprite.soundBank = new SilentSoundBank(clock, sprite);
    }
    let nextFrame = clock.time + runtime.currentStepTime;
    const advance = async (ms: number) => {
        const end = clock.time + ms;
        while (!disposed && nextFrame <= end) {
            clock.skipTo(nextFrame);
            await nextTask();
            if (disposed) return;
            clock.run(() => runtime._step());
            // A frame that took longer than a frame's time delays the next one, as on screen.
            nextFrame = Math.max(nextFrame + runtime.currentStepTime, clock.time);
        }
        if (!disposed) clock.skipTo(end);
    };

    const sprites = (): Target[] => runtime.targets.filter((target: Target) => target.isOriginal && !target.isStage);
    const findSprite = (name: string | undefined): Target | undefined => {
        if (name === undefined || name === '@first') return sprites()[0];
        if (name === '@stage') return runtime.getTargetForStage();
        return sprites().find(target => target.getName() === name);
    };
    const findVariable = (reading: Reading, type: '' | 'list') => {
        const names = variants(reading.name).map(String);
        const stage = runtime.getTargetForStage();
        const sprite = reading.sprite === undefined ? undefined : findSprite(reading.sprite);
        if (reading.sprite !== undefined && !sprite) return undefined;
        const order = sprite ? [sprite, stage] : [stage, ...sprites()];
        for (const target of order) {
            const variable = Object.values(target.variables as Record<string, Target>)
                .find(candidate => candidate.type === type && names.includes(candidate.name));
            if (variable) return variable;
        }
        return undefined;
    };

    const grading: GradingRuntime = {
        greenFlag: () => clock.run(() => vm.greenFlag()),
        key: (key, isDown) => clock.run(() => vm.postIOData('keyboard', {key, isDown})),
        clickSprite: name => {
            const target = findSprite(name);
            if (!target || target.isStage) return false;
            clock.run(() => runtime.startHats('event_whenthisspriteclicked', null, target));
            return true;
        },
        mouseMove: (x, y) => clock.run(() => vm.postIOData('mouse', {
            x: x + STAGE_WIDTH / 2, y: STAGE_HEIGHT / 2 - y, canvasWidth: STAGE_WIDTH, canvasHeight: STAGE_HEIGHT
        })),
        answer: text => clock.run(() => runtime.emit('ANSWER', text)),
        // Hats compare broadcast names in upper case.
        broadcast: message => clock.run(() => runtime.startHats('event_whenbroadcastreceived', {BROADCAST_OPTION: message.toUpperCase()})),
        stop: () => clock.run(() => vm.stopAll()),
        advance,
        read: reading => {
            switch (reading.target) {
            case 'sprite': {
                const target = findSprite(reading.sprite);
                if (!target || target.isStage) return undefined;
                switch (reading.property) {
                case 'x': return target.x;
                case 'y': return target.y;
                case 'direction': return target.direction;
                case 'size': return target.size;
                case 'visible': return target.visible;
                case 'costume': return costumeName(target);
                case 'sayText': return sayText(target);
                case 'touchingEdge': return target.isTouchingEdge();
                default: return undefined;
                }
            }
            case 'variable': return findVariable(reading, '')?.value;
            case 'list': {
                const list = findVariable(reading, 'list');
                if (!list) return undefined;
                if (reading.property === 'length') return list.value.length;
                if (reading.property === 'item' && typeof reading.index === 'number') return list.value[reading.index - 1];
                return undefined;
            }
            case 'stage':
                return reading.property === 'backdrop' ? costumeName(runtime.getTargetForStage()) : undefined;
            case 'music':
                if (reading.property === 'tempo') return runtime.getTargetForStage().tempo;
                return reading.property === 'notes' || reading.property === 'beats' ? [...played[reading.property]] : undefined;
            case 'clones': {
                const target = findSprite(reading.sprite);
                if (!target || target.isStage) return undefined;
                return runtime.targets.filter((clone: Target) => !clone.isOriginal && clone.sprite === target.sprite).length;
            }
            default:
                return undefined;
            }
        },
        dispose
    };
    return grading;
});
