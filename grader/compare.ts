// Comparing a value from the project (or, in dynamic checks, from the running project) with
// the value a rule expects. Shared by static and dynamic checks.

export const OPS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between', 'contains'] as const;
export type Op = typeof OPS[number];

/** A per-language expected value: matching either language is enough. */
export interface Localized {
    ko?: unknown;
    en?: unknown;
}

export interface Condition {
    op: Op;
    value: unknown;
    tolerance?: number;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

export const isLocalized = (value: unknown): value is Localized =>
    isObject(value) && ('ko' in value || 'en' in value) && Object.keys(value).every(key => key === 'ko' || key === 'en');

/** The values a (possibly per-language) expected value stands for. */
export const variants = (value: unknown): unknown[] => (isLocalized(value) ?
    [value.ko, value.en].filter(variant => variant !== undefined) :
    [value]);

/** A number when Scratch would treat the value as one, otherwise null. */
const toNumber = (value: unknown): number | null => {
    if (typeof value === 'number') return Number.isNaN(value) ? null : value;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (typeof value !== 'string' || value.trim() === '') return null;
    const number = Number(value);
    return Number.isNaN(number) ? null : number;
};

const toText = (value: unknown): string => String(value ?? '').toLowerCase();

/** Like Scratch's comparison: numbers when both sides are numbers, otherwise case-insensitive text. */
const compare = (actual: unknown, expected: unknown): number => {
    const a = toNumber(actual);
    const b = toNumber(expected);
    if (a !== null && b !== null) return a - b;
    const textA = toText(actual);
    const textB = toText(expected);
    if (textA === textB) return 0;
    return textA < textB ? -1 : 1;
};

const equals = (actual: unknown, expected: unknown, tolerance: number): boolean => {
    const a = toNumber(actual);
    const b = toNumber(expected);
    if (a !== null && b !== null) return Math.abs(a - b) <= tolerance;
    return compare(actual, expected) === 0;
};

/** Reads a rule's `{op, value}`, or a bare value which means `eq`. Throws on an unknown op. */
export const toCondition = (spec: unknown): Condition => {
    if (isObject(spec) && 'op' in spec) {
        if (!(OPS as readonly unknown[]).includes(spec.op)) throw new Error(`unknown op: ${String(spec.op)}`);
        if (spec.tolerance !== undefined && typeof spec.tolerance !== 'number') {
            throw new Error('tolerance must be a number');
        }
        if (spec.op === 'between' && !(Array.isArray(spec.value) && spec.value.length === 2)) {
            throw new Error('between needs value: [min, max]');
        }
        return {op: spec.op as Op, value: spec.value, tolerance: spec.tolerance as number | undefined};
    }
    return {op: 'eq', value: spec};
};

/** True when `actual` meets the condition. With a per-language value, either language may match. */
export const matches = (actual: unknown, condition: Condition): boolean => {
    const tolerance = condition.tolerance ?? 0;
    if (condition.op === 'between') {
        const [min, max] = condition.value as [unknown, unknown];
        return compare(actual, min) >= -tolerance && compare(actual, max) <= tolerance;
    }
    const any = (test: (expected: unknown) => boolean) => variants(condition.value).some(test);
    switch (condition.op) {
    case 'eq': return any(expected => equals(actual, expected, tolerance));
    case 'ne': return !any(expected => equals(actual, expected, tolerance));
    case 'gt': return any(expected => compare(actual, expected) > 0);
    case 'gte': return any(expected => compare(actual, expected) >= 0);
    case 'lt': return any(expected => compare(actual, expected) < 0);
    case 'lte': return any(expected => compare(actual, expected) <= 0);
    case 'contains': return any(expected => toText(actual).includes(toText(expected)));
    }
};

/** A short text of the condition for check results, e.g. "gt 10". */
export const describeCondition = (condition: Condition): string =>
    `${condition.op} ${JSON.stringify(condition.value)}${condition.tolerance ? ` ±${condition.tolerance}` : ''}`;
