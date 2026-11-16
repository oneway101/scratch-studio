import {describe, expect, it} from 'vitest';
import {validateSiteRequest} from './protocol';

describe('validateSiteRequest: setSaveStatus', () => {
    it('takes a status with the version exportProject or grade returned', () => {
        expect(validateSiteRequest('setSaveStatus', {status: 'saved', version: 0})).toBeNull();
        expect(validateSiteRequest('setSaveStatus', {status: 'saving', version: 12})).toBeNull();
        expect(validateSiteRequest('setSaveStatus', {status: 'failed', version: 3})).toBeNull();
    });

    it('refuses a status without a version, since it could answer any save', () => {
        expect(validateSiteRequest('setSaveStatus', {status: 'saved'})).toMatch(/version/);
    });

    it('refuses a version that is not a whole number from 0 up', () => {
        for (const version of [-1, 1.5, '3', null, NaN]) {
            expect(validateSiteRequest('setSaveStatus', {status: 'saved', version})).toMatch(/version/);
        }
    });

    it('still checks the status first', () => {
        expect(validateSiteRequest('setSaveStatus', {status: 'done', version: 1})).toMatch(/status/);
    });
});
