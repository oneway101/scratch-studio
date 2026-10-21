// The grading engine. It runs inside the editor, but it is plain TypeScript with no UI so it
// can be unit tested. Checks are the `checks` of a lesson step (protocol.ts `Check`).
import type {Check} from '../editor/protocol';
import {runDynamicCheck, type CreateRuntime, type DynamicCheck} from './dynamic';
import {readProject, type Sb3Project, type Target} from './project';
import {GraderError, type CheckResult} from './result';
import {runStaticCheck, type StaticCheck} from './static';

export {GraderError, type CheckResult} from './result';
export {STATIC_RULES, type StaticCheck, type StaticRule} from './static';
export {ACTIONS, type CreateRuntime, type DynamicCheck, type GradingRuntime, type Reading} from './dynamic';

export interface Graded {
    result: 'pass' | 'fail';
    checkResults: CheckResult[];
}

/** True when the check (or a check inside its anyOf) runs the project. */
const isDynamic = (check: Check): boolean =>
    check.type === 'dynamic' || (check.type === 'anyOf' && Array.isArray(check.checks) && check.checks.some(isDynamic));

const runStatic = (check: Check, targets: Target[]): CheckResult => {
    switch (check.type) {
    case 'static':
        return runStaticCheck(check as StaticCheck, targets);
    case 'anyOf':
        return anyOf(check, check.checks!.map(inner => runStatic(inner, targets)));
    case 'record':
        // Input tables are graded by the site with what the student typed.
        return {type: 'record', pass: true, detail: 'graded by the site'};
    case 'dynamic':
        throw new GraderError('dynamic checks need a runtime');
    default:
        throw new GraderError(`unknown check type: ${String(check.type)}`);
    }
};

const anyOf = (check: Check, results: CheckResult[]): CheckResult => ({
    type: 'anyOf',
    pass: results.some(inner => inner.pass),
    detail: `${results.filter(inner => inner.pass).length} of ${check.checks!.length} passed`,
    checks: results
});

const validate = (checks: Check[]) => {
    if (!Array.isArray(checks)) throw new GraderError('checks must be a list');
    const visit = (check: Check) => {
        if (typeof check !== 'object' || check === null) throw new GraderError('each check must be an object');
        if (check.type === 'anyOf') {
            if (!Array.isArray(check.checks) || check.checks.length === 0) throw new GraderError('anyOf needs checks');
            check.checks.forEach(visit);
        }
    };
    checks.forEach(visit);
};

const read = (project: string | Sb3Project): Target[] => {
    try {
        return readProject(project);
    } catch (e) {
        throw new GraderError(`cannot read the project: ${(e as Error).message}`);
    }
};

/**
 * Runs static checks (and `anyOf` groups of them) on the project JSON from `vm.toJSON()`.
 * Every check must pass. Throws GraderError when a check or the project cannot be read;
 * the caller reports that as `error`, not as a failure.
 */
export const gradeStatic = (project: string | Sb3Project, checks: Check[]): Graded => {
    validate(checks);
    const targets = read(project);
    const checkResults = checks.map(check => runStatic(check, targets));
    return {result: checkResults.every(check => check.pass) ? 'pass' : 'fail', checkResults};
};

/** Runs a check that may run the project. Inside anyOf, stops at the first check that passes. */
const runAny = async (check: Check, targets: Target[], createRuntime: CreateRuntime): Promise<CheckResult> => {
    if (check.type === 'dynamic') return runDynamicCheck(check as unknown as DynamicCheck, createRuntime);
    if (check.type !== 'anyOf' || !isDynamic(check)) return runStatic(check, targets);
    const results: CheckResult[] = [];
    for (const inner of check.checks!) {
        const result = await runAny(inner, targets, createRuntime);
        results.push(result);
        if (result.pass) break;
    }
    return anyOf(check, results);
};

/**
 * Grades a step. Static checks run first on the project JSON; if one fails, the dynamic checks
 * are skipped. Dynamic checks then run one by one, each on a fresh runtime from `createRuntime`,
 * and grading stops at the first failure. Throws GraderError when grading itself goes wrong.
 */
export const grade = async (project: string | Sb3Project, checks: Check[], createRuntime: CreateRuntime): Promise<Graded> => {
    validate(checks);
    const targets = read(project);
    const results: (CheckResult | null)[] = checks.map(check => (isDynamic(check) ? null : runStatic(check, targets)));
    let failed = results.some(result => result && !result.pass);
    for (let i = 0; i < checks.length; i++) {
        if (results[i]) continue;
        if (failed) {
            results[i] = {type: checks[i].type, pass: false, detail: 'skipped: an earlier check failed'};
            continue;
        }
        results[i] = await runAny(checks[i], targets, createRuntime);
        failed = !results[i]!.pass;
    }
    const checkResults = results as CheckResult[];
    return {result: checkResults.every(check => check.pass) ? 'pass' : 'fail', checkResults};
};
