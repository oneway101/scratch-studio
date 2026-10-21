import {describe, expect, it} from 'vitest';
import {matches, toCondition} from './compare';

const is = (actual: unknown, spec: unknown) => matches(actual, toCondition(spec));

describe('compare', () => {
    it('compares numbers as numbers, even when written as text', () => {
        expect(is('10', {op: 'eq', value: 10})).toBe(true);
        expect(is('10.0', 10)).toBe(true);
        expect(is('9', {op: 'lt', value: '10'})).toBe(true);
        expect(is(-5, {op: 'gte', value: -5})).toBe(true);
        expect(is(3, {op: 'gt', value: 3})).toBe(false);
        expect(is(3, {op: 'lte', value: 3})).toBe(true);
    });

    it('compares text without case, like Scratch', () => {
        expect(is('Hello', 'hello')).toBe(true);
        expect(is('Hello', {op: 'ne', value: 'HELLO'})).toBe(false);
        expect(is('', {op: 'ne', value: ''})).toBe(false);
        expect(is('', 0)).toBe(false);
    });

    it('applies tolerance to numbers', () => {
        expect(is(103, {op: 'eq', value: 100, tolerance: 5})).toBe(true);
        expect(is(106, {op: 'eq', value: 100, tolerance: 5})).toBe(false);
        expect(is(106, {op: 'ne', value: 100, tolerance: 5})).toBe(true);
        expect(is(-3, {op: 'between', value: [0, 10], tolerance: 5})).toBe(true);
    });

    it('checks between inclusively', () => {
        expect(is(0, {op: 'between', value: [0, 10]})).toBe(true);
        expect(is(10, {op: 'between', value: [0, 10]})).toBe(true);
        expect(is(11, {op: 'between', value: [0, 10]})).toBe(false);
    });

    it('finds text with contains', () => {
        expect(is('You found it!', {op: 'contains', value: 'FOUND'})).toBe(true);
        expect(is('x: -180', {op: 'contains', value: -180})).toBe(true);
        expect(is('nothing', {op: 'contains', value: 'found'})).toBe(false);
    });

    it('accepts either language of a per-language value', () => {
        expect(is('명중!', {op: 'contains', value: {ko: '명중', en: 'Hit'}})).toBe(true);
        expect(is('hit!', {op: 'contains', value: {ko: '명중', en: 'Hit'}})).toBe(true);
        expect(is('miss', {op: 'contains', value: {ko: '명중', en: 'Hit'}})).toBe(false);
        expect(is('score', {ko: '점수', en: 'score'})).toBe(true);
        expect(is('score', {op: 'ne', value: {ko: '점수', en: 'score'}})).toBe(false);
    });

    it('compares lists item by item, and their beginning with startsWith', () => {
        expect(is([60, 62, 64], [60, 62, 64])).toBe(true);
        expect(is([60, 62], [60, 62, 64])).toBe(false);
        expect(is([60, 62, 64, 65], {op: 'startsWith', value: [60, 62, 64]})).toBe(true);
        expect(is([60, 62], {op: 'startsWith', value: [60, 62, 64]})).toBe(false);
        expect(is([1, 0.5], {op: 'startsWith', value: [1, 0.48], tolerance: 0.05})).toBe(true);
        expect(is(60, [60])).toBe(false);
        expect(is('Hello there', {op: 'startsWith', value: 'hello'})).toBe(true);
    });

    it('rejects unknown ops and a malformed between', () => {
        expect(() => toCondition({op: 'near', value: 1})).toThrow();
        expect(() => toCondition({op: 'between', value: 1})).toThrow();
        expect(() => toCondition({op: 'eq', value: 1, tolerance: '2'})).toThrow();
    });
});
