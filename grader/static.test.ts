import {describe, expect, it} from 'vitest';
import type {Check} from '../editor/protocol';
import {b, flag, project, sprite, whenKey} from './fixtures/build';
import {gradeStatic, GraderError} from './index';
import type {Sb3Project} from './project';
import arrowKeysJson from './fixtures/arrow-keys.json';

const arrowKeys = JSON.stringify(arrowKeysJson);

const check = (rule: string, options: Record<string, unknown> = {}): Check => ({type: 'static', rule, ...options});
const passes = (proj: string | Sb3Project, ...checks: Check[]) => gradeStatic(proj, checks).result === 'pass';

describe('hasBlock', () => {
    it('finds a block in a script', () => {
        expect(passes(arrowKeys, check('hasBlock', {opcode: 'motion_gotoxy'}))).toBe(true);
        expect(passes(arrowKeys, check('hasBlock', {opcode: 'motion_glidesecstoxy'}))).toBe(false);
    });

    it('counts minCount over every sprite', () => {
        // Explorer and Treasure have one "go to x y" each.
        expect(passes(arrowKeys, check('hasBlock', {opcode: 'motion_gotoxy', minCount: 2}))).toBe(true);
        expect(passes(arrowKeys, check('hasBlock', {opcode: 'motion_gotoxy', minCount: 3}))).toBe(false);
        expect(passes(arrowKeys, check('hasBlock', {opcode: 'motion_gotoxy', sprite: 'Explorer', minCount: 2}))).toBe(false);
    });

    it('looks only in the named sprite', () => {
        expect(passes(arrowKeys, check('hasBlock', {opcode: 'sound_play', sprite: 'Treasure'}))).toBe(true);
        expect(passes(arrowKeys, check('hasBlock', {opcode: 'sound_play', sprite: 'Explorer'}))).toBe(false);
    });

    it('fails when the named sprite is not in the project', () => {
        expect(passes(arrowKeys, check('hasBlock', {opcode: 'motion_gotoxy', sprite: 'Pirate'}))).toBe(false);
    });

    it('reads @first as the first sprite and @stage as the stage', () => {
        expect(passes(arrowKeys, check('hasBlock', {opcode: 'control_forever', sprite: '@first'}))).toBe(true);
        expect(passes(arrowKeys, check('hasBlock', {opcode: 'sound_play', sprite: '@first'}))).toBe(false);
        expect(passes(arrowKeys, check('hasBlock', {opcode: 'looks_switchbackdropto', sprite: '@stage'}))).toBe(true);
        expect(passes(arrowKeys, check('hasBlock', {opcode: 'motion_gotoxy', sprite: '@stage'}))).toBe(false);
    });

    it('treats a missing sprite and @any as every target, the stage included', () => {
        expect(passes(arrowKeys, check('hasBlock', {opcode: 'looks_switchbackdropto'}))).toBe(true);
        expect(passes(arrowKeys, check('hasBlock', {opcode: 'looks_switchbackdropto', sprite: '@any'}))).toBe(true);
    });

    it('fails @first when there is no sprite', () => {
        const empty = project([], {scripts: [[flag(), b('control_forever')]]});
        expect(passes(empty, check('hasBlock', {opcode: 'control_forever', sprite: '@first'}))).toBe(false);
    });

    it('finds blocks nested in C-blocks and inputs', () => {
        expect(passes(arrowKeys, check('hasBlock', {opcode: 'motion_ifonedgebounce'}))).toBe(true);
        expect(passes(arrowKeys, check('hasBlock', {opcode: 'operator_random'}))).toBe(true);
        expect(passes(arrowKeys, check('hasBlock', {opcode: 'sensing_keypressed'}))).toBe(true);
    });

    it('counts a variable dropped into an input', () => {
        expect(passes(arrowKeys, check('hasBlock', {opcode: 'data_variable', sprite: 'Explorer'}))).toBe(true);
    });

    it('leaves out blocks not under a hat unless includeDetached', () => {
        expect(passes(arrowKeys, check('hasBlock', {opcode: 'motion_turnright'}))).toBe(false);
        expect(passes(arrowKeys, check('hasBlock', {opcode: 'motion_turnright', includeDetached: true}))).toBe(true);
        // A variable reporter alone on the workspace counts only with includeDetached.
        expect(passes(arrowKeys, check('hasBlock', {opcode: 'data_variable', minCount: 2}))).toBe(false);
        expect(passes(arrowKeys, check('hasBlock', {opcode: 'data_variable', minCount: 2, includeDetached: true}))).toBe(true);
    });

    it('does not count menu shadows', () => {
        expect(passes(arrowKeys, check('hasBlock', {opcode: 'sensing_keyoptions'}))).toBe(false);
        expect(passes(arrowKeys, check('hasBlock', {opcode: 'sound_sounds_menu'}))).toBe(false);
    });

    it('matches dropdown values on the block and on its menu', () => {
        expect(passes(arrowKeys, check('hasBlock', {opcode: 'event_whenkeypressed', fields: {KEY_OPTION: 'space'}}))).toBe(true);
        expect(passes(arrowKeys, check('hasBlock', {opcode: 'event_whenkeypressed', fields: {KEY_OPTION: 'up arrow'}}))).toBe(false);
        expect(passes(arrowKeys, check('hasBlock', {opcode: 'sensing_keypressed', fields: {KEY_OPTION: 'right arrow'}}))).toBe(true);
        expect(passes(arrowKeys, check('hasBlock', {opcode: 'sensing_keypressed', fields: {KEY_OPTION: 'left arrow'}}))).toBe(false);
        expect(passes(arrowKeys, check('hasBlock', {opcode: 'sound_play', fields: {SOUND_MENU: 'chime'}}))).toBe(true);
    });

    it('compares typed input values', () => {
        const random = (from: unknown, to: unknown) =>
            check('hasBlock', {opcode: 'operator_random', inputs: {FROM: from, TO: to}});
        expect(passes(arrowKeys, random({op: 'eq', value: 1}, {op: 'eq', value: 10}))).toBe(true);
        expect(passes(arrowKeys, random(1, 10))).toBe(true);
        expect(passes(arrowKeys, random({op: 'eq', value: 2}, {op: 'eq', value: 10}))).toBe(false);
        expect(passes(arrowKeys, random({op: 'lt', value: 5}, {op: 'between', value: [5, 20]}))).toBe(true);
        expect(passes(arrowKeys, random({op: 'gt', value: 1}, 10))).toBe(false);
        expect(passes(arrowKeys, check('hasBlock', {opcode: 'looks_sayforsecs', inputs: {MESSAGE: {ko: '안녕', en: 'hello!'}}}))).toBe(true);
    });

    it('does not match an input that holds a block', () => {
        // "change x by (steps)": the 10 under the variable is not what the student sees.
        expect(passes(arrowKeys, check('hasBlock', {opcode: 'motion_changexby', inputs: {DX: 10}}))).toBe(false);
        expect(passes(arrowKeys, check('hasBlock', {opcode: 'motion_changexby'}))).toBe(true);
    });
});

describe('broadcast menus', () => {
    // vm.toJSON() stores the broadcast dropdown compressed: [1, [11, name, id]].
    const broadcast = (message: string): Sb3Project => {
        const proj = project([sprite('Cat', [[flag(), b('event_broadcast')]])]);
        const block = Object.values(proj.targets[1].blocks!)
            .find(raw => (raw as {opcode: string}).opcode === 'event_broadcast') as {inputs: Record<string, unknown>};
        block.inputs.BROADCAST_INPUT = [1, [11, message, 'msg-id']];
        return proj;
    };

    it('compares the chosen message with fields', () => {
        const rule = check('hasBlock', {opcode: 'event_broadcast', fields: {BROADCAST_INPUT: 'start'}});
        expect(passes(broadcast('start'), rule)).toBe(true);
        expect(passes(broadcast('stop'), rule)).toBe(false);
    });

    it('does not count the menu as a block', () => {
        expect(passes(broadcast('start'), check('blockCount', {sprite: 'Cat', min: 2, max: 2}))).toBe(true);
    });
});

describe('notHasBlock', () => {
    it('passes only when the block is missing', () => {
        expect(passes(arrowKeys, check('notHasBlock', {opcode: 'motion_glidesecstoxy'}))).toBe(true);
        expect(passes(arrowKeys, check('notHasBlock', {opcode: 'control_forever'}))).toBe(false);
    });

    it('looks only in the named sprite', () => {
        expect(passes(arrowKeys, check('notHasBlock', {opcode: 'control_forever', sprite: 'Treasure'}))).toBe(true);
        expect(passes(arrowKeys, check('notHasBlock', {opcode: 'control_forever', sprite: 'Explorer'}))).toBe(false);
    });

    it('fails when the named sprite is not in the project', () => {
        expect(passes(arrowKeys, check('notHasBlock', {opcode: 'control_forever', sprite: 'Ghost'}))).toBe(false);
        expect(passes(project([]), check('notHasBlock', {opcode: 'control_forever', sprite: '@first'}))).toBe(false);
    });

    it('ignores a loose block unless includeDetached', () => {
        expect(passes(arrowKeys, check('notHasBlock', {opcode: 'motion_turnright'}))).toBe(true);
        expect(passes(arrowKeys, check('notHasBlock', {opcode: 'motion_turnright', includeDetached: true}))).toBe(false);
    });
});

describe('blockCount', () => {
    it('checks the count of one opcode against min and max', () => {
        expect(passes(arrowKeys, check('blockCount', {opcode: 'motion_gotoxy', min: 2, max: 2}))).toBe(true);
        expect(passes(arrowKeys, check('blockCount', {opcode: 'motion_gotoxy', max: 1}))).toBe(false);
        expect(passes(arrowKeys, check('blockCount', {opcode: 'motion_gotoxy', min: 3}))).toBe(false);
    });

    it('counts every non-shadow block when opcode is left out', () => {
        // Treasure: hat, go to, wait until, touching, play sound.
        expect(passes(arrowKeys, check('blockCount', {sprite: 'Treasure', min: 5, max: 5}))).toBe(true);
        expect(passes(arrowKeys, check('blockCount', {sprite: 'Treasure', max: 4}))).toBe(false);
    });

    it('fails when the named sprite is not in the project', () => {
        expect(passes(arrowKeys, check('blockCount', {opcode: 'control_forever', sprite: 'Ghost', max: 3}))).toBe(false);
    });

    it('needs min or max', () => {
        expect(() => gradeStatic(arrowKeys, [check('blockCount', {opcode: 'motion_gotoxy'})])).toThrow(GraderError);
    });
});

describe('sequence', () => {
    const proj = project([sprite('Cat', [[
        flag(),
        b('motion_gotoxy', {inputs: {X: 0, Y: 0}}),
        b('control_repeat', {inputs: {TIMES: 10}, substack: [
            b('motion_movesteps', {inputs: {STEPS: 10}}),
            b('looks_nextcostume')
        ]}),
        b('looks_say', {inputs: {MESSAGE: 'done'}})
    ]])]);

    it('finds blocks in order with others in between', () => {
        expect(passes(proj, check('sequence', {opcodes: ['motion_gotoxy', 'looks_say']}))).toBe(true);
        expect(passes(proj, check('sequence', {opcodes: ['looks_say', 'motion_gotoxy']}))).toBe(false);
    });

    it('follows the blocks inside C-blocks in running order', () => {
        expect(passes(proj, check('sequence', {opcodes: ['control_repeat', 'motion_movesteps', 'looks_nextcostume', 'looks_say']}))).toBe(true);
        expect(passes(proj, check('sequence', {opcodes: ['event_whenflagclicked', 'looks_nextcostume']}))).toBe(true);
    });

    it('with strict, allows nothing in between', () => {
        expect(passes(proj, check('sequence', {opcodes: ['motion_gotoxy', 'control_repeat'], strict: true}))).toBe(true);
        expect(passes(proj, check('sequence', {opcodes: ['motion_gotoxy', 'motion_movesteps'], strict: true}))).toBe(false);
        expect(passes(proj, check('sequence', {opcodes: ['motion_gotoxy', 'motion_movesteps']}))).toBe(true);
    });

    it('visits the if branch before the else branch whatever the JSON key order', () => {
        const ifElse = project([sprite('Cat', [[flag(), b('control_if_else', {
            substack: [b('looks_say')], substack2: [b('looks_think')]
        })]])]);
        // The student filled the else branch first, so SUBSTACK2 comes first in the JSON.
        const block = Object.values(ifElse.targets[1].blocks!)
            .find(raw => (raw as {opcode: string}).opcode === 'control_if_else') as {inputs: Record<string, unknown>};
        block.inputs = {SUBSTACK2: block.inputs.SUBSTACK2, SUBSTACK: block.inputs.SUBSTACK};
        expect(passes(ifElse, check('sequence', {opcodes: ['looks_say', 'looks_think']}))).toBe(true);
        expect(passes(ifElse, check('sequence', {opcodes: ['looks_think', 'looks_say']}))).toBe(false);
    });

    it('needs the blocks in one script', () => {
        const split = project([sprite('Cat', [[flag(), b('motion_gotoxy')], [whenKey('space'), b('looks_say')]])]);
        expect(passes(split, check('sequence', {opcodes: ['motion_gotoxy', 'looks_say']}))).toBe(false);
    });

    it('checks loose stacks only with includeDetached', () => {
        const loose = project([sprite('Cat', [[b('motion_gotoxy'), b('looks_say')]])]);
        expect(passes(loose, check('sequence', {opcodes: ['motion_gotoxy', 'looks_say']}))).toBe(false);
        expect(passes(loose, check('sequence', {opcodes: ['motion_gotoxy', 'looks_say'], includeDetached: true}))).toBe(true);
    });

    it('needs a list of opcodes', () => {
        expect(() => gradeStatic(proj, [check('sequence', {opcodes: []})])).toThrow(GraderError);
    });
});

describe('inside', () => {
    it('finds a block anywhere inside the parent, inputs included', () => {
        expect(passes(arrowKeys, check('inside', {parent: 'control_forever', child: 'motion_changexby'}))).toBe(true);
        expect(passes(arrowKeys, check('inside', {parent: 'control_forever', child: 'sensing_keypressed'}))).toBe(true);
        expect(passes(arrowKeys, check('inside', {parent: 'control_if', child: 'motion_ifonedgebounce'}))).toBe(true);
    });

    it('does not count the blocks after the parent', () => {
        // "go to x y" comes before "forever"; "set score" has "pick random" in its input.
        expect(passes(arrowKeys, check('inside', {parent: 'control_forever', child: 'motion_gotoxy'}))).toBe(false);
        expect(passes(arrowKeys, check('inside', {parent: 'motion_gotoxy', child: 'control_forever'}))).toBe(false);
        expect(passes(arrowKeys, check('inside', {parent: 'data_setvariableto', child: 'operator_random'}))).toBe(true);
    });

    it('looks only in the named sprite', () => {
        expect(passes(arrowKeys, check('inside', {parent: 'control_forever', child: 'motion_changexby', sprite: 'Treasure'}))).toBe(false);
    });
});

describe('underHat', () => {
    it('finds a block in a script under the hat', () => {
        expect(passes(arrowKeys, check('underHat', {hat: 'event_whenflagclicked', opcode: 'motion_changexby'}))).toBe(true);
        expect(passes(arrowKeys, check('underHat', {hat: 'event_whenkeypressed', opcode: 'looks_sayforsecs'}))).toBe(true);
        expect(passes(arrowKeys, check('underHat', {hat: 'event_whenkeypressed', opcode: 'motion_gotoxy'}))).toBe(false);
    });

    it('looks only in the named sprite', () => {
        expect(passes(arrowKeys, check('underHat', {hat: 'event_whenflagclicked', opcode: 'sound_play', sprite: 'Treasure'}))).toBe(true);
        expect(passes(arrowKeys, check('underHat', {hat: 'event_whenflagclicked', opcode: 'sound_play', sprite: 'Explorer'}))).toBe(false);
    });

    it('does not count the hat itself', () => {
        expect(passes(arrowKeys, check('underHat', {hat: 'event_whenflagclicked', opcode: 'event_whenflagclicked'}))).toBe(false);
    });
});

describe('variableExists', () => {
    it('finds a variable for all sprites and a sprite\'s own variable', () => {
        expect(passes(arrowKeys, check('variableExists', {name: 'score'}))).toBe(true);
        expect(passes(arrowKeys, check('variableExists', {name: 'steps'}))).toBe(true);
        expect(passes(arrowKeys, check('variableExists', {name: 'lives'}))).toBe(false);
    });

    it('accepts either language', () => {
        expect(passes(arrowKeys, check('variableExists', {name: {ko: '점수', en: 'score'}}))).toBe(true);
        expect(passes(arrowKeys, check('variableExists', {name: {ko: '점수', en: 'points'}}))).toBe(false);
    });

    it('with a sprite, sees its own variables and the stage\'s', () => {
        expect(passes(arrowKeys, check('variableExists', {name: 'steps', sprite: 'Explorer'}))).toBe(true);
        expect(passes(arrowKeys, check('variableExists', {name: 'score', sprite: 'Treasure'}))).toBe(true);
        expect(passes(arrowKeys, check('variableExists', {name: 'steps', sprite: 'Treasure'}))).toBe(false);
        expect(passes(arrowKeys, check('variableExists', {name: 'score', sprite: 'Pirate'}))).toBe(false);
    });

    it('separates variables and lists', () => {
        expect(passes(arrowKeys, check('variableExists', {kind: 'list', name: 'items'}))).toBe(true);
        expect(passes(arrowKeys, check('variableExists', {kind: 'list', name: 'score'}))).toBe(false);
        expect(passes(arrowKeys, check('variableExists', {kind: 'variable', name: 'items'}))).toBe(false);
    });

    it('without a name, passes when any exists', () => {
        expect(passes(arrowKeys, check('variableExists', {kind: 'list'}))).toBe(true);
        expect(passes(project([sprite('Cat')]), check('variableExists', {kind: 'list'}))).toBe(false);
    });
});

describe('spriteCount', () => {
    it('counts sprites, not the stage', () => {
        expect(passes(arrowKeys, check('spriteCount', {min: 2, max: 2}))).toBe(true);
        expect(passes(arrowKeys, check('spriteCount', {min: 3}))).toBe(false);
        expect(passes(arrowKeys, check('spriteCount', {max: 1}))).toBe(false);
    });
});

describe('gradeStatic', () => {
    it('passes only when every check passes', () => {
        const ok = check('hasBlock', {opcode: 'motion_gotoxy'});
        const no = check('hasBlock', {opcode: 'motion_glidesecstoxy'});
        expect(gradeStatic(arrowKeys, [ok, ok]).result).toBe('pass');
        const graded = gradeStatic(arrowKeys, [ok, no]);
        expect(graded.result).toBe('fail');
        expect(graded.checkResults.map(result => result.pass)).toEqual([true, false]);
        expect(graded.checkResults[1].detail).toContain('found 0');
    });

    it('passes anyOf when one of its checks passes', () => {
        const anyOf = (...checks: Check[]): Check => ({type: 'anyOf', checks});
        const ok = check('hasBlock', {opcode: 'motion_gotoxy'});
        const no = check('hasBlock', {opcode: 'motion_glidesecstoxy'});
        expect(passes(arrowKeys, anyOf(no, ok))).toBe(true);
        expect(passes(arrowKeys, anyOf(no, no))).toBe(false);
        const graded = gradeStatic(arrowKeys, [anyOf(no, ok)]);
        expect(graded.checkResults[0].checks?.map(result => result.pass)).toEqual([false, true]);
    });

    it('leaves input tables to the site', () => {
        expect(passes(arrowKeys, {type: 'record', key: 'record'})).toBe(true);
    });

    it('reads the project as a string or an object', () => {
        expect(passes(arrowKeysJson as unknown as Sb3Project, check('hasBlock', {opcode: 'motion_gotoxy'}))).toBe(true);
    });

    it('throws GraderError for checks it cannot run', () => {
        const bad: Check[][] = [
            [check('hasBlok', {opcode: 'motion_gotoxy'})],
            [check('hasBlock')],
            [check('hasBlock', {opcode: 'motion_gotoxy', minCount: '2'})],
            [check('hasBlock', {opcode: 'motion_gotoxy', inputs: {X: {op: 'near', value: 0}}})],
            [check('hasBlock', {opcode: 'motion_gotoxy', sprite: 3})],
            [check('variableExists', {kind: 'dictionary'})],
            [{type: 'anyOf', checks: []}],
            [{type: 'unknown'}],
            [{type: 'dynamic', actions: [], expect: []}]
        ];
        for (const checks of bad) expect(() => gradeStatic(arrowKeys, checks), JSON.stringify(checks)).toThrow(GraderError);
    });

    it('throws GraderError when the project cannot be read', () => {
        expect(() => gradeStatic('not json', [])).toThrow(GraderError);
        expect(() => gradeStatic('{}', [])).toThrow(GraderError);
    });
});
