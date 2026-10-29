// Static checks: rules over the project JSON. Blocks are matched by opcode, so the editor
// language does not matter.
import {describeCondition, matches, toCondition, variants, type Condition} from './compare';
import {
    countedBlocks, descendants, fieldValue, inputValue, scriptBlocks, scriptStarts, stackOrder,
    type Block, type Target
} from './project';
import {GraderError, type CheckResult} from './result';

export const STATIC_RULES = [
    'hasBlock', 'notHasBlock', 'blockCount', 'sequence', 'inside', 'underHat', 'variableExists', 'spriteCount'
] as const;
export type StaticRule = typeof STATIC_RULES[number];

export interface StaticCheck {
    type: 'static';
    rule: StaticRule;
    [option: string]: unknown;
}

/**
 * The targets a rule's `sprite` points to. `@any` (or no `sprite`) is every target, the stage
 * included; `@first` is the first sprite in the sprite list; a name that is not in the project
 * points to nothing, so the rule fails.
 */
const selectTargets = (targets: Target[], sprite: unknown): Target[] => {
    if (sprite === undefined || sprite === '@any') return targets;
    if (sprite === '@stage') return targets.filter(target => target.isStage);
    if (sprite === '@first') return targets.filter(target => !target.isStage).slice(0, 1);
    if (typeof sprite !== 'string') throw new GraderError('sprite must be a name, @any, @first or @stage');
    return targets.filter(target => target.name === sprite);
};

/** A named sprite (or @first) that points to nothing: rules that pass on "none found" must fail instead. */
const missingSprite = (check: StaticCheck, selected: Target[]): boolean =>
    selected.length === 0 && check.sprite !== undefined && check.sprite !== '@any';

const option = <T>(check: StaticCheck, name: string, type: 'string' | 'number' | 'boolean', required: boolean): T => {
    const value = check[name];
    if (value === undefined) {
        if (required) throw new GraderError(`${check.rule} needs ${name}`);
        return undefined as T;
    }
    if (typeof value !== type) throw new GraderError(`${check.rule}: ${name} must be a ${type}`);
    return value as T;
};

const stringList = (check: StaticCheck, name: string): string[] => {
    const value = check[name];
    if (!Array.isArray(value) || value.length === 0 || !value.every(item => typeof item === 'string')) {
        throw new GraderError(`${check.rule}: ${name} must be a list of opcodes`);
    }
    return value;
};

const toConditions = (rule: string, name: 'fields' | 'inputs', value: unknown): [string, Condition][] => {
    if (value === undefined) return [];
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new GraderError(`${rule}: ${name} must be an object`);
    }
    try {
        return Object.entries(value).map(([key, spec]) => [key, toCondition(spec)]);
    } catch (e) {
        throw new GraderError(`${rule}: ${name}: ${(e as Error).message}`);
    }
};

const conditions = (check: StaticCheck, name: 'fields' | 'inputs'): [string, Condition][] =>
    toConditions(check.rule, name, check[name]);

/** A block to look for: its opcode (any when undefined) and its dropdown and input values. */
interface BlockPattern {
    opcode: string | undefined;
    fields: [string, Condition][];
    inputs: [string, Condition][];
}

const fits = (target: Target, block: Block, pattern: BlockPattern): boolean =>
    (pattern.opcode === undefined || block.opcode === pattern.opcode) &&
    pattern.fields.every(([name, condition]) => matches(fieldValue(target, block, name), condition)) &&
    pattern.inputs.every(([name, condition]) => {
        const value = inputValue(block, name);
        return value !== undefined && matches(value, condition);
    });

/** Blocks with the opcode, and the given dropdown and input values, in the selected targets. */
const findBlocks = (check: StaticCheck, targets: Target[], opcode: string | undefined): Block[] => {
    const includeDetached = option<boolean>(check, 'includeDetached', 'boolean', false) ?? false;
    const pattern = {opcode, fields: conditions(check, 'fields'), inputs: conditions(check, 'inputs')};
    return targets.flatMap(target => countedBlocks(target, includeDetached).filter(block => fits(target, block, pattern)));
};

const describeFilters = (fields: [string, Condition][], inputs: [string, Condition][]): string =>
    [...fields, ...inputs].map(([name, condition]) => ` [${name} ${describeCondition(condition)}]`).join('');

const filters = (check: StaticCheck): string => describeFilters(conditions(check, 'fields'), conditions(check, 'inputs'));

/**
 * What each block of a sequence must be: `opcodes` gives only the opcodes, `blocks` also the
 * dropdown and input values ({opcode, fields, inputs}, as in hasBlock).
 */
const sequencePatterns = (check: StaticCheck): BlockPattern[] => {
    if (check.blocks === undefined) {
        return stringList(check, 'opcodes').map(opcode => ({opcode, fields: [], inputs: []}));
    }
    if (check.opcodes !== undefined) throw new GraderError('sequence: give opcodes or blocks, not both');
    if (!Array.isArray(check.blocks) || check.blocks.length === 0) {
        throw new GraderError('sequence: blocks must be a list of {opcode, fields, inputs}');
    }
    return check.blocks.map((item: unknown) => {
        if (typeof item !== 'object' || item === null || typeof (item as {opcode?: unknown}).opcode !== 'string') {
            throw new GraderError('sequence: each of blocks needs an opcode');
        }
        const {opcode, fields, inputs} = item as {opcode: string; fields?: unknown; inputs?: unknown};
        return {opcode, fields: toConditions('sequence', 'fields', fields), inputs: toConditions('sequence', 'inputs', inputs)};
    });
};

const result = (check: StaticCheck, pass: boolean, detail: string): CheckResult =>
    ({type: 'static', rule: check.rule, pass, detail});

/** A range rule's min and max; at least one is required. */
const range = (check: StaticCheck): {min?: number; max?: number; text: string} => {
    const min = option<number>(check, 'min', 'number', false);
    const max = option<number>(check, 'max', 'number', false);
    if (min === undefined && max === undefined) throw new GraderError(`${check.rule} needs min or max`);
    const text = [min !== undefined && `>= ${min}`, max !== undefined && `<= ${max}`].filter(Boolean).join(', ');
    return {min, max, text};
};
const inRange = (count: number, {min, max}: {min?: number; max?: number}) =>
    (min === undefined || count >= min) && (max === undefined || count <= max);

/** True when blocks fitting `wanted` appear in `blocks` in order; with `strict`, with nothing in between. */
const hasSequence = (target: Target, blocks: Block[], wanted: BlockPattern[], strict: boolean): boolean => {
    if (strict) {
        for (let start = 0; start + wanted.length <= blocks.length; start++) {
            if (wanted.every((pattern, i) => fits(target, blocks[start + i], pattern))) return true;
        }
        return false;
    }
    let next = 0;
    for (const block of blocks) {
        if (fits(target, block, wanted[next])) next++;
        if (next === wanted.length) return true;
    }
    return false;
};

const rules: Record<StaticRule, (check: StaticCheck, targets: Target[]) => CheckResult> = {
    hasBlock: (check, targets) => {
        const opcode = option<string>(check, 'opcode', 'string', true);
        const minCount = option<number>(check, 'minCount', 'number', false) ?? 1;
        const count = findBlocks(check, selectTargets(targets, check.sprite), opcode).length;
        return result(check, count >= minCount, `${opcode}${filters(check)}: found ${count}, need ${minCount}`);
    },

    notHasBlock: (check, targets) => {
        const opcode = option<string>(check, 'opcode', 'string', true);
        const selected = selectTargets(targets, check.sprite);
        if (missingSprite(check, selected)) return result(check, false, `sprite ${String(check.sprite)}: not found`);
        const count = findBlocks(check, selected, opcode).length;
        return result(check, count === 0, `${opcode}${filters(check)}: found ${count}, need 0`);
    },

    blockCount: (check, targets) => {
        const opcode = option<string>(check, 'opcode', 'string', false);
        const limits = range(check);
        const selected = selectTargets(targets, check.sprite);
        if (missingSprite(check, selected)) return result(check, false, `sprite ${String(check.sprite)}: not found`);
        const count = findBlocks(check, selected, opcode).length;
        return result(check, inRange(count, limits), `${opcode ?? 'all blocks'}: found ${count}, need ${limits.text}`);
    },

    sequence: (check, targets) => {
        const wanted = sequencePatterns(check);
        const strict = option<boolean>(check, 'strict', 'boolean', false) ?? false;
        const includeDetached = option<boolean>(check, 'includeDetached', 'boolean', false) ?? false;
        const pass = selectTargets(targets, check.sprite).some(target =>
            scriptStarts(target, includeDetached).some(start =>
                hasSequence(target, stackOrder(target, start.id), wanted, strict)));
        const text = wanted.map(pattern => `${pattern.opcode}${describeFilters(pattern.fields, pattern.inputs)}`).join(' > ');
        return result(check, pass, `${text}${strict ? ' (strict)' : ''}: ${pass ? 'found' : 'not found'}`);
    },

    inside: (check, targets) => {
        const parent = option<string>(check, 'parent', 'string', true);
        const child = option<string>(check, 'child', 'string', true);
        const includeDetached = option<boolean>(check, 'includeDetached', 'boolean', false) ?? false;
        const pass = selectTargets(targets, check.sprite).some(target =>
            countedBlocks(target, includeDetached)
                .filter(block => block.opcode === parent)
                .some(block => descendants(target, block.id)
                    .some(id => !target.blocks.get(id)!.shadow && target.blocks.get(id)!.opcode === child)));
        return result(check, pass, `${child} inside ${parent}: ${pass ? 'found' : 'not found'}`);
    },

    underHat: (check, targets) => {
        const hat = option<string>(check, 'hat', 'string', true);
        const opcode = option<string>(check, 'opcode', 'string', true);
        const pass = selectTargets(targets, check.sprite).some(target =>
            scriptStarts(target, false)
                .filter(start => start.opcode === hat)
                .some(start => scriptBlocks(target, start.id).slice(1)
                    .some(id => !target.blocks.get(id)!.shadow && target.blocks.get(id)!.opcode === opcode)));
        return result(check, pass, `${opcode} under ${hat}: ${pass ? 'found' : 'not found'}`);
    },

    variableExists: (check, targets) => {
        const kind = option<string>(check, 'kind', 'string', false) ?? 'variable';
        if (kind !== 'variable' && kind !== 'list') throw new GraderError('variableExists: kind must be variable or list');
        const names = check.name === undefined ? null : variants(check.name);
        if (names && !names.every(name => typeof name === 'string')) {
            throw new GraderError('variableExists: name must be text or {ko, en}');
        }
        // A sprite also sees the stage's variables ("for all sprites").
        const selected = selectTargets(targets, check.sprite);
        const visible = check.sprite === undefined || check.sprite === '@any' || selected.length === 0 ?
            selected :
            [...new Set([...selected, ...targets.filter(target => target.isStage)])];
        const found = visible.flatMap(target => (kind === 'variable' ? target.variables : target.lists));
        const pass = names === null ?
            found.length > 0 :
            found.some(name => names.some(wanted => name.trim() === (wanted as string).trim()));
        return result(check, pass, `${kind} ${names ? JSON.stringify(check.name) : '(any)'}: ${pass ? 'found' : 'not found'}`);
    },

    spriteCount: (check, targets) => {
        const limits = range(check);
        const count = targets.filter(target => !target.isStage).length;
        return result(check, inRange(count, limits), `sprites: found ${count}, need ${limits.text}`);
    }
};

export const isStaticRule = (rule: unknown): rule is StaticRule =>
    (STATIC_RULES as readonly unknown[]).includes(rule);

/** Runs one static check. Throws GraderError when the check itself is malformed. */
export const runStaticCheck = (check: StaticCheck, targets: Target[]): CheckResult => {
    if (!isStaticRule(check.rule)) throw new GraderError(`unknown static rule: ${String(check.rule)}`);
    return rules[check.rule](check, targets);
};
