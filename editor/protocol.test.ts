import {describe, expect, it} from 'vitest';
import {validateSiteRequest} from './protocol';

describe('validateSiteRequest: setSaveStatus', () => {
    it('takes a status with the exportId exportProject or grade returned', () => {
        expect(validateSiteRequest('setSaveStatus', {status: 'saved', exportId: 1})).toBeNull();
        expect(validateSiteRequest('setSaveStatus', {status: 'saving', exportId: 12})).toBeNull();
        expect(validateSiteRequest('setSaveStatus', {status: 'failed', exportId: 3})).toBeNull();
    });

    it('refuses a status without an exportId, since it could answer any save', () => {
        expect(validateSiteRequest('setSaveStatus', {status: 'saved'})).toMatch(/exportId/);
    });

    it('refuses an exportId that is not a whole number from 1 up', () => {
        for (const exportId of [0, -1, 1.5, '3', null, NaN]) {
            expect(validateSiteRequest('setSaveStatus', {status: 'saved', exportId})).toMatch(/exportId/);
        }
    });

    it('still checks the status first', () => {
        expect(validateSiteRequest('setSaveStatus', {status: 'done', exportId: 1})).toMatch(/status/);
    });
});
