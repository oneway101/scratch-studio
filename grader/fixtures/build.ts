// Builds project JSON fixtures in the sb3 format that vm.toJSON() returns, so tests can
// describe scripts briefly. arrow-keys.json is a hand-written fixture in the same format.
import type {Sb3Project} from '../project';

/** A literal number or text, a reporter block, a variable reporter, or a dropdown menu shadow. */
type InputSpec = number | string | BlockSpec | {variable: string} | {menu: string; value: string};

export interface BlockSpec {
    opcode: string;
    fields?: Record<string, string>;
    inputs?: Record<string, InputSpec>;
    substack?: BlockSpec[];
    substack2?: BlockSpec[];
}

export const b = (opcode: string, rest: Omit<BlockSpec, 'opcode'> = {}): BlockSpec => ({opcode, ...rest});

interface TargetSpec {
    name: string;
    isStage?: boolean;
    scripts?: BlockSpec[][];
    variables?: string[];
    lists?: string[];
}

// Variable and list fields carry the id the target's variables use.
const FIELD_IDS: Record<string, (name: string) => string> = {
    VARIABLE: name => `var-${name}`,
    LIST: name => `list-${name}`
};

const serializeTarget = (spec: TargetSpec, prefix: string) => {
    const blocks: Record<string, unknown> = {};
    let counter = 0;
    const newId = () => `${prefix}${counter++}`;

    const addStack = (stack: BlockSpec[], parent: string | null, topLevel: boolean): string | null => {
        const ids = stack.map(() => newId());
        stack.forEach((block, i) => addBlock(block, ids[i], i === 0 ? parent : ids[i - 1], ids[i + 1] ?? null,
            topLevel && i === 0));
        return ids[0] ?? null;
    };

    const addBlock = (spec: BlockSpec, id: string, parent: string | null, next: string | null, topLevel: boolean) => {
        const inputs: Record<string, unknown> = {};
        const fields: Record<string, unknown> = {};
        for (const [name, value] of Object.entries(spec.fields || {})) fields[name] = [value, FIELD_IDS[name]?.(value) ?? null];
        const block: Record<string, unknown> = {opcode: spec.opcode, next, parent, inputs, fields, shadow: false, topLevel};
        if (topLevel) Object.assign(block, {x: 0, y: 0});
        blocks[id] = block;
        for (const [name, value] of Object.entries(spec.inputs || {})) {
            if (typeof value === 'number') inputs[name] = [1, [4, String(value)]];
            else if (typeof value === 'string') inputs[name] = [1, [10, value]];
            else if ('variable' in value) inputs[name] = [3, [12, value.variable, `var-${value.variable}`], [10, '']];
            else if ('menu' in value) {
                const menuId = newId();
                blocks[menuId] = {
                    opcode: value.menu, next: null, parent: id, inputs: {}, fields: {[name]: [value.value, null]},
                    shadow: true, topLevel: false
                };
                inputs[name] = [1, menuId];
            } else {
                const childId = newId();
                addBlock(value, childId, id, null, false);
                inputs[name] = [3, childId, [10, '']];
            }
        }
        if (spec.substack) inputs.SUBSTACK = [2, addStack(spec.substack, id, false)];
        if (spec.substack2) inputs.SUBSTACK2 = [2, addStack(spec.substack2, id, false)];
    };

    for (const script of spec.scripts || []) addStack(script, null, true);

    return {
        isStage: spec.isStage === true,
        name: spec.name,
        variables: Object.fromEntries((spec.variables || []).map(name => [`var-${name}`, [name, 0]])),
        lists: Object.fromEntries((spec.lists || []).map(name => [`list-${name}`, [name, []]])),
        broadcasts: {},
        blocks
    };
};

/** A project with a stage and the given sprites, in sprite list order. */
export const project = (sprites: TargetSpec[], stage: Omit<TargetSpec, 'name'> = {}): Sb3Project => ({
    targets: [
        serializeTarget({...stage, name: 'Stage', isStage: true}, 'stage-'),
        ...sprites.map((sprite, i) => serializeTarget(sprite, `s${i}-`))
    ]
} as unknown as Sb3Project);

export const sprite = (name: string, scripts: BlockSpec[][] = [], rest: Omit<TargetSpec, 'name' | 'scripts'> = {}) =>
    ({name, scripts, ...rest});

export const flag = () => b('event_whenflagclicked');
export const whenKey = (key: string) => b('event_whenkeypressed', {fields: {KEY_OPTION: key}});
