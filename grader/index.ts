// The grading engine. It runs inside the editor, but it is plain TypeScript with no UI so it
// can be unit tested. Checks are the `checks` of a lesson step (protocol.ts `Check`).
import type {Check} from '../editor/protocol';
import {readProject, type Sb3Project, type Target} from './project';
import {GraderError, type CheckResult} from './result';
import {runStaticCheck, type StaticCheck} from './static';

export {GraderError, type CheckResult} from './result';
export {STATIC_RULES, type StaticCheck, type StaticRule} from './static';

export interface StaticGrade {
    result: 'pass' | 'fail';
    checkResults: CheckResult[];
}

const runCheck = (check: Check, targets: Target[]): CheckResult => {
    switch (check.type) {
    case 'static':
        return runStaticCheck(check as StaticCheck, targets);
    case 'anyOf': {
        if (!Array.isArray(check.checks) || check.checks.length === 0) throw new GraderError('anyOf needs checks');
        const results = check.checks.map(inner => runCheck(inner, targets));
        const pass = results.some(inner => inner.pass);
        return {type: 'anyOf', pass, detail: `${results.filter(inner => inner.pass).length} of ${results.length} passed`, checks: results};
    }
    case 'record':
        // Input tables are graded by the site with what the student typed.
        return {type: 'record', pass: true, detail: 'graded by the site'};
    case 'dynamic':
        throw new GraderError('dynamic checks are not built yet (stage 3)');
    default:
        throw new GraderError(`unknown check type: ${String(check.type)}`);
    }
};

/**
 * Runs static checks (and `anyOf` groups of them) on the project JSON from `vm.toJSON()`.
 * Every check must pass. Throws GraderError when a check or the project cannot be read;
 * the caller reports that as `error`, not as a failure.
 */
export const gradeStatic = (project: string | Sb3Project, checks: Check[]): StaticGrade => {
    let targets: Target[];
    try {
        targets = readProject(project);
    } catch (e) {
        throw new GraderError(`cannot read the project: ${(e as Error).message}`);
    }
    if (!Array.isArray(checks)) throw new GraderError('checks must be a list');
    const checkResults = checks.map(check => {
        if (typeof check !== 'object' || check === null) throw new GraderError('each check must be an object');
        return runCheck(check, targets);
    });
    return {result: checkResults.every(check => check.pass) ? 'pass' : 'fail', checkResults};
};
