/** What one check found. Only for debugging: the site shows students pass or fail alone. */
export interface CheckResult {
    type: string;
    rule?: string;
    pass: boolean;
    detail: string;
    /** The results inside `anyOf`. */
    checks?: CheckResult[];
}

/** A check that cannot be run as written (unknown rule, missing option). Grading reports `error`. */
export class GraderError extends Error {
    constructor (message: string) {
        super(message);
        this.name = 'GraderError';
    }
}
