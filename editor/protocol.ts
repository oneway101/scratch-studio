// The postMessage contract between the host site and the editor.
// This file is the only contract between the two repositories. The site follows these definitions
// as they are; changing a message means bumping VERSION.

export const SOURCE = 'scratch-studio';
export const VERSION = 1;

export const LOCALES = ['ko', 'en'] as const;
export type Locale = typeof LOCALES[number];

/** edit: the student's editor. player: stage and green flag only. view: blocks visible, changes not saved. */
export const MODES = ['edit', 'player', 'view'] as const;
export type Mode = typeof MODES[number];

export const SAVE_STATUSES = ['saved', 'saving', 'failed'] as const;
export type SaveStatus = typeof SAVE_STATUSES[number];

export type GradeResult = 'pass' | 'fail' | 'error';

export const ERROR_CODES = [
    'unsupported_version', // the message's version is not VERSION
    'unknown_type', // the type is not a site request
    'invalid_payload', // the payload does not match this file
    'wrong_mode', // the request is not allowed in the current mode (save messages outside edit)
    'not_implemented', // the request is defined but not built yet
    'failed' // the request was valid but handling it threw
] as const;
export type ErrorCode = typeof ERROR_CODES[number];

/** A grading rule. The grader defines the full shape (docs/grader.md). */
export interface Check {
    type: string;
    timeoutMs?: number;
    runs?: number;
    checks?: Check[];
    [option: string]: unknown;
}

type Empty = Record<string, never>;

/**
 * Requests the site sends. The editor replies with a message of the same `type` and `requestId`
 * carrying `reply` as its payload, or with `error`.
 */
export interface SiteRequests {
    init: {payload: {locale: Locale; mode: Mode}; reply: Empty};
    /** `sb3: null` opens an empty project. */
    loadProject: {payload: {sb3: ArrayBuffer | null}; reply: Empty};
    exportProject: {payload: Empty; reply: {sb3: ArrayBuffer}};
    /** 480x360 PNG of the stage, for thumbnails. */
    captureStage: {payload: Empty; reply: {png: ArrayBuffer}};
    grade: {
        payload: {checks: Check[]};
        reply: {result: GradeResult; checkResults: unknown[]; sb3: ArrayBuffer};
    };
    setMode: {payload: {mode: Mode}; reply: Empty};
    /** edit mode only. */
    setSaveStatus: {payload: {status: SaveStatus}; reply: Empty};
}
export type SiteRequestType = keyof SiteRequests;

/** Messages the editor sends on its own. `error` also answers a request, with that request's `requestId`. */
export interface EditorEvents {
    ready: Empty;
    /** edit mode only. */
    projectChanged: Empty;
    /** The student picked a language in the editor's language menu. Not sent for `init`. */
    localeChanged: {locale: Locale};
    /** The student pressed "Save" or "Retry" in the menu bar. edit mode only. */
    saveRequested: Empty;
    error: {code: ErrorCode; message: string};
}
export type EditorEventType = keyof EditorEvents;

export interface Envelope<T extends string, P> {
    source: typeof SOURCE;
    version: typeof VERSION;
    type: T;
    requestId?: string;
    payload: P;
}

export type SiteMessage = {
    [T in SiteRequestType]: Envelope<T, SiteRequests[T]['payload']>
}[SiteRequestType];

export type EditorMessage =
    | {[T in EditorEventType]: Envelope<T, EditorEvents[T]>}[EditorEventType]
    | {[T in SiteRequestType]: Envelope<T, SiteRequests[T]['reply']>}[SiteRequestType];

export const SITE_REQUEST_TYPES: SiteRequestType[] = [
    'init', 'loadProject', 'exportProject', 'captureStage', 'grade', 'setMode', 'setSaveStatus'
];

/** Request timeouts the host site applies. */
export const LOAD_TIMEOUT_MS = 15000;
export const EXPORT_TIMEOUT_MS = 15000;
export const DEFAULT_DYNAMIC_TIMEOUT_MS = 5000;
const GRADE_EXTRA_MS = 5000;

/** Sum of timeoutMs x runs over every dynamic check (including inside anyOf), plus 5 seconds. */
export const gradeTimeoutMs = (checks: Check[]): number => {
    const sum = (list: Check[]): number => list.reduce((total, check) => {
        if (check.type === 'anyOf') return total + sum(check.checks || []);
        if (check.type !== 'dynamic') return total;
        return total + (check.timeoutMs ?? DEFAULT_DYNAMIC_TIMEOUT_MS) * (check.runs ?? 1);
    }, 0);
    return sum(checks) + GRADE_EXTRA_MS;
};

const includes = <T extends string>(list: readonly T[], value: unknown): value is T =>
    typeof value === 'string' && (list as readonly string[]).includes(value);

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/** True when `data` has the envelope of this protocol (any version, any type). */
export const isStudioEnvelope = (data: unknown): data is Envelope<string, unknown> & {version: number} =>
    isObject(data) && data.source === SOURCE && typeof data.version === 'number' && typeof data.type === 'string';

/** Checks a site request's payload. Returns what is wrong, or null when it is valid. */
export const validateSiteRequest = (type: SiteRequestType, payload: unknown): string | null => {
    const p = isObject(payload) ? payload : {};
    switch (type) {
    case 'init':
        if (!includes(LOCALES, p.locale)) return `locale must be one of ${LOCALES.join(', ')}`;
        if (!includes(MODES, p.mode)) return `mode must be one of ${MODES.join(', ')}`;
        return null;
    case 'loadProject':
        return p.sb3 === null || p.sb3 instanceof ArrayBuffer ? null : 'sb3 must be an ArrayBuffer or null';
    case 'grade':
        return Array.isArray(p.checks) && p.checks.every(isObject) ? null : 'checks must be an array of objects';
    case 'setMode':
        return includes(MODES, p.mode) ? null : `mode must be one of ${MODES.join(', ')}`;
    case 'setSaveStatus':
        return includes(SAVE_STATUSES, p.status) ? null : `status must be one of ${SAVE_STATUSES.join(', ')}`;
    default:
        return null;
    }
};
