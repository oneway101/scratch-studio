// Dynamic checks: run the project, then read its state. The project runs in a GradingRuntime,
// which the editor builds on a second, invisible VM; tests use a fake one.
import {describeCondition, matches, toCondition, type Condition} from './compare';
import {GraderError, type CheckResult} from './result';

export const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_KEY_MS = 100;

export const ACTIONS = ['greenFlag', 'keyPress', 'clickSprite', 'mouseMove', 'answer', 'broadcast', 'wait', 'stop'] as const;
export type ActionName = typeof ACTIONS[number];

export interface Action {
    do: ActionName;
    [option: string]: unknown;
}

/** What each `expect` target can read. Targets without properties read one value. */
export const READINGS: Record<string, readonly string[]> = {
    sprite: ['x', 'y', 'direction', 'size', 'visible', 'costume', 'sayText', 'touchingEdge'],
    variable: [],
    list: ['length', 'item'],
    stage: ['backdrop'],
    clones: []
};

/** What to read from the running project. Targets and properties are in docs/grader.md. */
export interface Reading {
    target: string;
    sprite?: string;
    property?: string;
    name?: unknown;
    index?: number;
}

export interface Expectation extends Reading {
    op: string;
    value: unknown;
    tolerance?: number;
}

export interface DynamicCheck {
    type: 'dynamic';
    actions: Action[];
    expect: Expectation[];
    timeoutMs?: number;
    runs?: number;
    passIf?: 'all' | 'any';
}

/** A project loaded and running in its own VM. */
export interface GradingRuntime {
    greenFlag (): void;
    key (key: string, isDown: boolean): void;
    /** False when the sprite is not in the project. */
    clickSprite (sprite: string): boolean;
    mouseMove (x: number, y: number): void;
    answer (text: string): void;
    broadcast (message: string): void;
    stop (): void;
    /** The value now, or undefined when there is nothing to read (no such sprite, variable, ...). */
    read (reading: Reading): unknown;
    dispose (): void;
}

/** Loads the snapshot into a new runtime. */
export type CreateRuntime = () => Promise<GradingRuntime>;

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const isInitialRef = (value: unknown) => isObject(value) && value.ref === 'initial';

const number = (action: Action, name: string, fallback?: number): number => {
    const value = action[name] ?? fallback;
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new GraderError(`${action.do}: ${name} must be a number`);
    return value;
};
const duration = (action: Action, name: string, fallback?: number): number => {
    const value = number(action, name, fallback);
    if (value < 0) throw new GraderError(`${action.do}: ${name} must not be negative`);
    return value;
};
const text = (action: Action, name: string): string => {
    const value = action[name];
    if (typeof value !== 'string' && typeof value !== 'number') throw new GraderError(`${action.do} needs ${name}`);
    return String(value);
};

const validateReading = (reading: Reading) => {
    const properties = READINGS[reading.target];
    if (!properties) throw new GraderError(`expect: unknown target ${String(reading.target)}`);
    if (properties.length > 0 && !properties.includes(reading.property as string)) {
        throw new GraderError(`expect: ${reading.target} property must be one of ${properties.join(', ')}`);
    }
    if ((reading.target === 'variable' || reading.target === 'list') && reading.name === undefined) {
        throw new GraderError(`expect: ${reading.target} needs name`);
    }
    if (reading.property === 'item' && typeof reading.index !== 'number') throw new GraderError('expect: item needs index');
    if (reading.sprite !== undefined && typeof reading.sprite !== 'string') throw new GraderError('expect: sprite must be text');
};

/** Checks the shape of a dynamic check before anything runs, so a bad rule is an error, not a failure. */
const validate = (check: DynamicCheck): {conditions: Condition[]} => {
    if (!Array.isArray(check.actions) || !check.actions.every(isObject)) throw new GraderError('dynamic needs actions');
    if (!Array.isArray(check.expect) || check.expect.length === 0 || !check.expect.every(isObject)) {
        throw new GraderError('dynamic needs expect');
    }
    for (const action of check.actions) {
        if (!(ACTIONS as readonly unknown[]).includes(action.do)) throw new GraderError(`unknown action: ${String(action.do)}`);
    }
    for (const name of ['timeoutMs', 'runs'] as const) {
        const value = check[name];
        if (value !== undefined && !(typeof value === 'number' && value > 0)) throw new GraderError(`${name} must be a positive number`);
    }
    if (check.passIf !== undefined && check.passIf !== 'all' && check.passIf !== 'any') {
        throw new GraderError('passIf must be all or any');
    }
    const conditions = check.expect.map(expectation => {
        validateReading(expectation);
        try {
            return toCondition({op: expectation.op, value: expectation.value, tolerance: expectation.tolerance});
        } catch (e) {
            throw new GraderError(`expect: ${(e as Error).message}`);
        }
    });
    return {conditions};
};

const runAction = async (runtime: GradingRuntime, action: Action, isAborted: () => boolean) => {
    switch (action.do) {
    case 'greenFlag': return runtime.greenFlag();
    case 'stop': return runtime.stop();
    case 'wait': return sleep(duration(action, 'ms'));
    case 'keyPress': {
        const key = text(action, 'key');
        runtime.key(key, true);
        await sleep(duration(action, 'durationMs', DEFAULT_KEY_MS));
        if (!isAborted()) runtime.key(key, false);
        return;
    }
    case 'clickSprite': {
        const sprite = text(action, 'sprite');
        if (!runtime.clickSprite(sprite)) throw new MissingTarget(`clickSprite: no sprite ${sprite}`);
        return;
    }
    case 'mouseMove': return runtime.mouseMove(number(action, 'x'), number(action, 'y'));
    case 'answer': return runtime.answer(text(action, 'text'));
    case 'broadcast': return runtime.broadcast(text(action, 'message'));
    }
};

/** An action points at something the project does not have: the check fails, like a missing sprite. */
class MissingTarget extends Error {}

const label = (expectation: Expectation): string => {
    const subject = [expectation.target, expectation.sprite, expectation.name !== undefined && JSON.stringify(expectation.name),
        expectation.property, expectation.index].filter(part => part !== undefined && part !== false).join('.');
    return subject;
};

const show = (value: unknown) => (value === undefined ? 'nothing' : JSON.stringify(value));

/** One run: load, act, read. Resolves to a failure detail, or null when every expectation holds. */
const runOnce = async (check: DynamicCheck, conditions: Condition[], createRuntime: CreateRuntime): Promise<string | null> => {
    const timeoutMs = check.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let aborted = false;
    let runtime: GradingRuntime | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<string>(resolve => {
        timer = setTimeout(() => resolve(`timed out after ${timeoutMs}ms`), timeoutMs);
    });
    const run = async (): Promise<string | null> => {
        runtime = await createRuntime();
        const initial = check.expect.map(expectation => (isInitialRef(expectation.value) ? runtime!.read(expectation) : undefined));
        for (const action of check.actions) {
            if (aborted) return null;
            try {
                await runAction(runtime, action, () => aborted);
            } catch (e) {
                if (e instanceof MissingTarget) return e.message;
                throw e;
            }
        }
        if (aborted) return null;
        const failures = check.expect.flatMap((expectation, i) => {
            const actual = runtime!.read(expectation);
            const condition = isInitialRef(expectation.value) ? {...conditions[i], value: initial[i]} : conditions[i];
            if (actual !== undefined && condition.value !== undefined && matches(actual, condition)) return [];
            return [`${label(expectation)} ${describeCondition(condition)}, got ${show(actual)}`];
        });
        return failures.length ? failures.join('; ') : null;
    };
    const running = run();
    running.catch(() => {}); // a run that fails after the timeout has nobody left to tell
    try {
        return await Promise.race([running, timedOut]);
    } finally {
        aborted = true;
        clearTimeout(timer);
        // Read after the race: `runtime` is assigned inside run().
        const loaded = runtime as GradingRuntime | null;
        if (loaded) {
            loaded.stop();
            loaded.dispose();
        }
    }
};

/**
 * Runs a dynamic check `runs` times, each on a fresh runtime. Passes when every run passes,
 * or any run with `passIf: "any"`. Throws GraderError when the check is malformed.
 */
export const runDynamicCheck = async (check: DynamicCheck, createRuntime: CreateRuntime): Promise<CheckResult> => {
    const {conditions} = validate(check);
    const runs = check.runs ?? 1;
    const passIf = check.passIf ?? 'all';
    const failures: string[] = [];
    let passed = 0;
    for (let i = 0; i < runs; i++) {
        const failure = await runOnce(check, conditions, createRuntime);
        if (failure === null) passed++;
        else failures.push(runs > 1 ? `run ${i + 1}: ${failure}` : failure);
        // Stop early once the outcome is settled.
        if (passIf === 'any' && passed > 0) break;
        if (passIf === 'all' && failures.length > 0) break;
    }
    const pass = passIf === 'any' ? passed > 0 : failures.length === 0;
    const detail = pass ?
        (runs > 1 ? `${passed} of ${runs} runs passed` : 'passed') :
        failures.join(' | ');
    return {type: 'dynamic', pass, detail};
};
