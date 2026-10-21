// Reading the project JSON that vm.toJSON() returns (the sb3 project.json format).
// The grader only reads it; nothing here touches the VM.

/** A value inside an input: a block id, a compressed primitive, or nothing. */
type Sb3InputValue = string | unknown[] | null;

interface Sb3Block {
    opcode: string;
    next: string | null;
    parent: string | null;
    inputs?: Record<string, [number, Sb3InputValue, Sb3InputValue?]>;
    fields?: Record<string, [unknown, unknown?]>;
    shadow?: boolean;
    topLevel?: boolean;
}

interface Sb3Target {
    isStage: boolean;
    name: string;
    variables?: Record<string, [string, unknown]>;
    lists?: Record<string, [string, unknown[]]>;
    blocks?: Record<string, Sb3Block | unknown[]>;
}

export interface Sb3Project {
    targets: Sb3Target[];
}

/** An input slot of a block: the block in it, or the literal typed into it. */
export interface InputSlot {
    block?: string;
    literal?: unknown;
}

export interface Block {
    id: string;
    opcode: string;
    shadow: boolean;
    topLevel: boolean;
    next: string | null;
    fields: Record<string, unknown>;
    inputs: Record<string, InputSlot>;
}

export interface Target {
    name: string;
    isStage: boolean;
    variables: string[];
    lists: string[];
    blocks: Map<string, Block>;
}

// Compressed primitives (sb3 serializer). 4-10 are literals; 11 is a broadcast menu; 12 and 13 are
// variable and list reporters.
const PRIMITIVE_BROADCAST = 11;
const PRIMITIVE_VARIABLE = 12;
const PRIMITIVE_LIST = 13;
const PRIMITIVE_OPCODES: Record<number, string> = {
    [PRIMITIVE_VARIABLE]: 'data_variable',
    [PRIMITIVE_LIST]: 'data_listcontents'
};
// Input shadow types: 1 = only the shadow, 2 = a block without a shadow, 3 = a block covering a shadow.
const INPUT_SAME_BLOCK_SHADOW = 1;

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/** Adds the reporter a compressed variable or list primitive stands for, and returns its id. */
const addPrimitiveBlock = (blocks: Map<string, Block>, id: string, primitive: unknown[]): string | null => {
    const opcode = PRIMITIVE_OPCODES[primitive[0] as number];
    if (!opcode) return null;
    const field = opcode === 'data_variable' ? 'VARIABLE' : 'LIST';
    blocks.set(id, {
        id, opcode, shadow: false, topLevel: false, next: null, fields: {[field]: primitive[1]}, inputs: {}
    });
    return id;
};

const readTarget = (raw: Sb3Target): Target => {
    const blocks = new Map<string, Block>();
    const rawBlocks = isObject(raw.blocks) ? raw.blocks : {};
    for (const [id, rawBlock] of Object.entries(rawBlocks)) {
        if (Array.isArray(rawBlock)) {
            // A variable or list reporter left alone on the workspace.
            const added = addPrimitiveBlock(blocks, id, rawBlock);
            if (added) blocks.get(added)!.topLevel = true;
            continue;
        }
        if (!isObject(rawBlock) || typeof rawBlock.opcode !== 'string') continue;
        const fields: Record<string, unknown> = {};
        for (const [name, field] of Object.entries(rawBlock.fields || {})) {
            fields[name] = Array.isArray(field) ? field[0] : field;
        }
        const inputs: Record<string, InputSlot> = {};
        for (const [name, input] of Object.entries(rawBlock.inputs || {})) {
            if (!Array.isArray(input)) continue;
            const [shadowType, value] = input;
            if (typeof value === 'string') {
                inputs[name] = {block: value};
            } else if (Array.isArray(value) && value[0] === PRIMITIVE_BROADCAST) {
                // Stored compressed, but in the editor it is a menu shadow like any other dropdown.
                const menuId = `${id}:${name}`;
                blocks.set(menuId, {
                    id: menuId, opcode: 'event_broadcast_menu', shadow: true, topLevel: false, next: null,
                    fields: {BROADCAST_OPTION: value[1]}, inputs: {}
                });
                inputs[name] = {block: menuId};
            } else if (Array.isArray(value)) {
                const primitiveId = addPrimitiveBlock(blocks, `${id}:${name}`, value);
                if (primitiveId) inputs[name] = {block: primitiveId};
                else if (shadowType === INPUT_SAME_BLOCK_SHADOW) inputs[name] = {literal: value[1]};
                else inputs[name] = {};
            }
        }
        blocks.set(id, {
            id,
            opcode: rawBlock.opcode,
            shadow: rawBlock.shadow === true,
            topLevel: rawBlock.topLevel === true,
            next: typeof rawBlock.next === 'string' ? rawBlock.next : null,
            fields,
            inputs
        });
    }
    const names = (record: unknown): string[] => (isObject(record) ?
        Object.values(record).filter(Array.isArray)
            .map(entry => entry[0])
            .filter((name): name is string => typeof name === 'string') :
        []);
    return {
        name: String(raw.name),
        isStage: raw.isStage === true,
        variables: names(raw.variables),
        lists: names(raw.lists),
        blocks
    };
};

/** Reads the project JSON (a string or the parsed object). Throws when it is not a project. */
export const readProject = (json: string | Sb3Project): Target[] => {
    const project: unknown = typeof json === 'string' ? JSON.parse(json) : json;
    if (!isObject(project) || !Array.isArray(project.targets)) throw new Error('not a project: no targets');
    return project.targets.filter(isObject).map(target => readTarget(target as unknown as Sb3Target));
};

/** Hat blocks start a script: event "when ..." blocks, "when I start as a clone", custom block definitions. */
export const isHat = (opcode: string): boolean =>
    /^[a-zA-Z0-9]+_when/.test(opcode) || opcode === 'control_start_as_clone' || opcode === 'procedures_definition';

/** Ids of the blocks inside a block: everything in its inputs and substacks, not the blocks after it. */
export const descendants = (target: Target, id: string): string[] => {
    const found: string[] = [];
    const visitChain = (start: string | undefined) => {
        let current = start;
        while (current) {
            const block = target.blocks.get(current);
            if (!block) return;
            found.push(current);
            visitInputs(block);
            current = block.next ?? undefined;
        }
    };
    const visitInputs = (block: Block) => {
        for (const slot of Object.values(block.inputs)) visitChain(slot.block);
    };
    const root = target.blocks.get(id);
    if (root) visitInputs(root);
    return found;
};

/** Ids of every block in the script that starts at `id`, the first block included. */
export const scriptBlocks = (target: Target, id: string): string[] => {
    const found: string[] = [];
    let current: string | null = id;
    while (current) {
        const block = target.blocks.get(current);
        if (!block) break;
        found.push(current);
        found.push(...descendants(target, current));
        current = block.next;
    }
    return found;
};

/**
 * Stack blocks of a script in the order they run: each block, then the blocks in its
 * substacks (C-blocks), then the next block. Reporters in inputs are left out.
 */
export const stackOrder = (target: Target, id: string): Block[] => {
    const found: Block[] = [];
    const visitChain = (start: string | null | undefined) => {
        let current = start;
        while (current) {
            const block = target.blocks.get(current);
            if (!block) return;
            found.push(block);
            // SUBSTACK before SUBSTACK2: the JSON key order follows the order the student filled them.
            for (const name of Object.keys(block.inputs).filter(key => key.startsWith('SUBSTACK')).sort()) {
                visitChain(block.inputs[name].block);
            }
            current = block.next;
        }
    };
    visitChain(id);
    return found;
};

/** First blocks of the scripts the grader looks at: hat scripts, plus loose stacks with `includeDetached`. */
export const scriptStarts = (target: Target, includeDetached: boolean): Block[] =>
    [...target.blocks.values()].filter(block => block.topLevel && !block.shadow &&
        (isHat(block.opcode) || includeDetached));

/** Non-shadow blocks the grader counts: those in hat scripts, or every block with `includeDetached`. */
export const countedBlocks = (target: Target, includeDetached: boolean): Block[] => {
    const ids = new Set<string>();
    for (const start of scriptStarts(target, includeDetached)) {
        for (const id of scriptBlocks(target, start.id)) ids.add(id);
    }
    return [...ids].map(id => target.blocks.get(id)!).filter(block => !block.shadow);
};

/**
 * The value chosen in a dropdown. Some dropdowns are fields of the block itself; others live
 * on a menu shadow in the input of the same name (e.g. the key in "key ( ) pressed?").
 */
export const fieldValue = (target: Target, block: Block, name: string): unknown => {
    if (name in block.fields) return block.fields[name];
    const menuId = block.inputs[name]?.block;
    const menu = menuId ? target.blocks.get(menuId) : undefined;
    if (!menu?.shadow) return undefined;
    if (name in menu.fields) return menu.fields[name];
    const values = Object.values(menu.fields);
    return values.length === 1 ? values[0] : undefined;
};

/** The number or text typed into an input, or undefined when a block is placed in it. */
export const inputValue = (block: Block, name: string): unknown => block.inputs[name]?.literal;
