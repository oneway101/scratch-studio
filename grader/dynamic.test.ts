import {describe, expect, it} from 'vitest';
import type {Check} from '../editor/protocol';
import {b, flag, project, sprite} from './fixtures/build';
import {grade, GraderError, type CreateRuntime, type GradingRuntime, type Reading} from './index';

/**
 * A stand-in for the VM: one sprite whose x moves 10 per right-arrow press, a "score" variable
 * set by the green flag, a say bubble set by a click, and a "time" variable with the project
 * time that has passed. Enough to drive the grading flow.
 */
interface World {
    x: number;
    score: number;
    say: string;
    keys: string[];
    time: number;
}

const fakeRuntime = (setup: Partial<World> = {}, log: string[] = []): CreateRuntime => async () => {
    const world: World = {x: 50, score: 0, say: '', keys: [], time: 0, ...setup};
    log.push('load');
    const runtime: GradingRuntime = {
        greenFlag: () => {
            world.x = 0;
            world.score = 3;
        },
        key: (key, isDown) => {
            world.keys.push(`${key}:${isDown ? 'down' : 'up'}`);
            if (key === 'ArrowRight' && isDown) world.x += 10;
        },
        clickSprite: name => {
            if (name !== 'Cat') return false;
            world.say = 'Meow!';
            return true;
        },
        mouseMove: () => {},
        answer: () => {},
        broadcast: () => {},
        stop: () => log.push('stop'),
        advance: async ms => {
            world.time += ms;
        },
        read: (reading: Reading) => {
            if (reading.target === 'sprite' && (reading.sprite === 'Cat' || reading.sprite === '@first')) {
                if (reading.property === 'x') return world.x;
                if (reading.property === 'sayText') return world.say;
                if (reading.property === 'costume') return world.keys.join(','); // the fake logs key events here
            }
            if (reading.target === 'variable' && reading.name === 'score') return world.score;
            if (reading.target === 'variable' && reading.name === 'time') return world.time;
            return undefined;
        },
        dispose: () => log.push('dispose')
    };
    return runtime;
};

const proj = JSON.stringify(project([sprite('Cat', [[flag(), b('motion_gotoxy')]])]));
const dynamic = (actions: unknown[], expectations: unknown[], rest: Record<string, unknown> = {}): Check =>
    ({type: 'dynamic', actions, expect: expectations, ...rest});
const x = (op: string, value: unknown) => ({target: 'sprite', sprite: '@first', property: 'x', op, value});

describe('dynamic checks', () => {
    it('runs the actions and checks the expectations', async () => {
        const check = dynamic([{do: 'greenFlag'}, {do: 'keyPress', key: 'ArrowRight', durationMs: 5}], [x('eq', 10)]);
        expect((await grade(proj, [check], fakeRuntime())).result).toBe('pass');
        const wrong = dynamic([{do: 'greenFlag'}], [x('eq', 10)]);
        const graded = await grade(proj, [wrong], fakeRuntime());
        expect(graded.result).toBe('fail');
        expect(graded.checkResults[0].detail).toContain('got 0');
    });

    it('compares with the value before the actions', async () => {
        const right = dynamic([{do: 'keyPress', key: 'ArrowRight', durationMs: 5}], [x('gt', {ref: 'initial'})]);
        expect((await grade(proj, [right], fakeRuntime())).result).toBe('pass');
        const flagOnly = dynamic([{do: 'greenFlag'}], [x('gt', {ref: 'initial'})]);
        expect((await grade(proj, [flagOnly], fakeRuntime())).result).toBe('fail');
    });

    it('presses a key for durationMs, then releases it', async () => {
        const check = dynamic([{do: 'keyPress', key: 'a', durationMs: 5}],
            [{target: 'sprite', sprite: 'Cat', property: 'costume', op: 'eq', value: 'a:down,a:up'}]);
        expect((await grade(proj, [check], fakeRuntime())).result).toBe('pass');
    });

    it('reads variables by name in either language', async () => {
        const check = dynamic([{do: 'greenFlag'}], [{target: 'variable', name: 'score', op: 'eq', value: 3}]);
        expect((await grade(proj, [check], fakeRuntime())).result).toBe('pass');
    });

    it('fails when there is nothing to read or click', async () => {
        const noSprite = dynamic([{do: 'greenFlag'}], [{target: 'sprite', sprite: 'Dog', property: 'x', op: 'eq', value: 0}]);
        expect((await grade(proj, [noSprite], fakeRuntime())).result).toBe('fail');
        const noClick = dynamic([{do: 'clickSprite', sprite: 'Dog'}], [x('eq', 50)]);
        const graded = await grade(proj, [noClick], fakeRuntime());
        expect(graded.result).toBe('fail');
        expect(graded.checkResults[0].detail).toContain('no sprite Dog');
        const click = dynamic([{do: 'clickSprite', sprite: 'Cat'}],
            [{target: 'sprite', sprite: 'Cat', property: 'sayText', op: 'contains', value: {ko: '야옹', en: 'meow'}}]);
        expect((await grade(proj, [click], fakeRuntime())).result).toBe('pass');
    });

    it('waits and holds keys in project time, not real time', async () => {
        const time = (value: number) => ({target: 'variable', name: 'time', op: 'eq', value});
        const long = dynamic([{do: 'greenFlag'}, {do: 'keyPress', key: 'a', durationMs: 250}, {do: 'wait', ms: 60000}],
            [time(60250)], {timeoutMs: 70000});
        const started = Date.now();
        expect((await grade(proj, [long], fakeRuntime())).result).toBe('pass');
        expect(Date.now() - started).toBeLessThan(250);
    });

    it('fails when the check runs past timeoutMs, and stops the runtime', async () => {
        const log: string[] = [];
        const slow = dynamic([{do: 'greenFlag'}, {do: 'wait', ms: 300}], [x('eq', 0)], {timeoutMs: 30});
        const started = Date.now();
        const graded = await grade(proj, [slow], fakeRuntime({}, log));
        expect(graded.result).toBe('fail');
        expect(graded.checkResults[0].detail).toContain('timed out after 30ms');
        expect(Date.now() - started).toBeLessThan(250);
        expect(log).toEqual(['load', 'stop', 'dispose']);
    });

    it('runs the project up to timeoutMs before it times out', async () => {
        let world: GradingRuntime | null = null;
        const keep: CreateRuntime = async () => (world = await fakeRuntime()());
        const slow = dynamic([{do: 'wait', ms: 200}, {do: 'wait', ms: 300}], [x('eq', 0)], {timeoutMs: 400});
        const graded = await grade(proj, [slow], keep);
        expect(graded.checkResults[0].detail).toContain('timed out after 400ms');
        expect(world!.read({target: 'variable', name: 'time'})).toBe(400);
    });

    it('disposes a runtime that finishes loading after the timeout', async () => {
        const log: string[] = [];
        const late: CreateRuntime = async () => {
            await new Promise(resolve => setTimeout(resolve, 60));
            return fakeRuntime({}, log)();
        };
        const graded = await grade(proj, [dynamic([], [x('eq', 0)], {timeoutMs: 20})], late);
        expect(graded.checkResults[0].detail).toContain('timed out');
        await new Promise(resolve => setTimeout(resolve, 80));
        expect(log).toEqual(['load', 'stop', 'dispose']);
    });

    it('accepts Scratch key names', async () => {
        const check = dynamic([{do: 'keyPress', key: 'right arrow', durationMs: 5}], [x('eq', 60)]);
        expect((await grade(proj, [check], fakeRuntime())).result).toBe('pass');
    });

    it('fails when loading never finishes', async () => {
        const never: CreateRuntime = () => new Promise(() => {});
        const graded = await grade(proj, [dynamic([], [x('eq', 0)], {timeoutMs: 20})], never);
        expect(graded.checkResults[0].detail).toContain('timed out');
    });

    it('uses a fresh runtime for every run and every check', async () => {
        const log: string[] = [];
        const check = dynamic([{do: 'greenFlag'}], [x('eq', 0)], {runs: 3});
        expect((await grade(proj, [check, check], fakeRuntime({}, log))).result).toBe('pass');
        expect(log.filter(entry => entry === 'load')).toHaveLength(6);
        expect(log.filter(entry => entry === 'dispose')).toHaveLength(6);
    });

    it('with passIf any, passes when one run passes', async () => {
        // Runs alternate between x = 10 and x = 20 after the green flag.
        let run = 0;
        const alternating: CreateRuntime = async () => {
            const offset = run++ % 2 === 0 ? 10 : 20;
            const runtime = await fakeRuntime()();
            return {...runtime, read: reading => (reading.property === 'x' ? offset : undefined)};
        };
        const twenty = (passIf: string) => dynamic([{do: 'greenFlag'}], [x('eq', 20)], {runs: 4, passIf});
        run = 0;
        expect((await grade(proj, [twenty('any')], alternating)).result).toBe('pass');
        run = 0;
        const all = await grade(proj, [twenty('all')], alternating);
        expect(all.result).toBe('fail');
        expect(all.checkResults[0].detail).toContain('run 1');
    });

    it('skips dynamic checks when a static check fails', async () => {
        const log: string[] = [];
        const staticFail: Check = {type: 'static', rule: 'hasBlock', opcode: 'looks_say'};
        const check = dynamic([{do: 'greenFlag'}], [x('eq', 0)]);
        const graded = await grade(proj, [check, staticFail], fakeRuntime({}, log));
        expect(graded.result).toBe('fail');
        expect(graded.checkResults[0].detail).toContain('skipped');
        expect(log).toEqual([]);
    });

    it('stops at the first failing dynamic check', async () => {
        const log: string[] = [];
        const fail = dynamic([{do: 'greenFlag'}], [x('eq', 99)]);
        const pass = dynamic([{do: 'greenFlag'}], [x('eq', 0)]);
        const graded = await grade(proj, [fail, pass], fakeRuntime({}, log));
        expect(graded.checkResults.map(result => result.pass)).toEqual([false, false]);
        expect(graded.checkResults[1].detail).toContain('skipped');
        expect(log.filter(entry => entry === 'load')).toHaveLength(1);
    });

    it('runs anyOf until one check passes', async () => {
        const log: string[] = [];
        const fail = dynamic([{do: 'greenFlag'}], [x('eq', 99)]);
        const pass = dynamic([{do: 'greenFlag'}], [x('eq', 0)]);
        const staticPass: Check = {type: 'static', rule: 'hasBlock', opcode: 'motion_gotoxy'};
        const graded = await grade(proj, [{type: 'anyOf', checks: [fail, pass, staticPass]}], fakeRuntime({}, log));
        expect(graded.result).toBe('pass');
        expect(graded.checkResults[0].checks?.map(result => result.pass)).toEqual([false, true]);
        expect(log.filter(entry => entry === 'load')).toHaveLength(2);
    });

    it('throws GraderError for malformed dynamic checks', async () => {
        const bad: Check[] = [
            dynamic([{do: 'jump'}], [x('eq', 0)]),
            dynamic([{do: 'greenFlag'}], []),
            dynamic([{do: 'greenFlag'}], [x('near', 0)]),
            dynamic([{do: 'greenFlag'}], [x('eq', 0)], {runs: 0}),
            dynamic([{do: 'greenFlag'}], [x('eq', 0)], {passIf: 'most'}),
            dynamic([{do: 'keyPress'}], [x('eq', 0)]),
            dynamic([{do: 'wait', ms: -1}], [x('eq', 0)]),
            dynamic([{do: 'greenFlag'}], [{target: 'sprite', property: 'colour', op: 'eq', value: 0}]),
            dynamic([{do: 'greenFlag'}], [{target: 'pen', op: 'eq', value: 0}]),
            dynamic([{do: 'greenFlag'}], [{target: 'music', property: 'volume', op: 'eq', value: 0}]),
            dynamic([{do: 'greenFlag'}], [{target: 'variable', op: 'eq', value: 0}]),
            dynamic([{do: 'greenFlag'}], [{target: 'list', name: 'items', property: 'item', op: 'eq', value: 0}])
        ];
        for (const check of bad) {
            await expect(grade(proj, [check], fakeRuntime()), JSON.stringify(check)).rejects.toThrow(GraderError);
        }
    });
});
