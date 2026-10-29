import {describe, expect, it} from 'vitest';
import {isProjectFileName, projectFileText} from './project-file';

describe('isProjectFileName', () => {
    it('accepts Scratch project extensions in any case', () => {
        for (const name of ['game.sb3', 'old.sb2', 'older.sb', 'GAME.SB3', '내 작품.sb3']) {
            expect(isProjectFileName(name)).toBe(true);
        }
    });
    it('rejects other files', () => {
        for (const name of ['cat.png', 'game.sb3.zip', 'game.sb4', 'sb3', 'game.sprite3']) {
            expect(isProjectFileName(name)).toBe(false);
        }
    });
});

describe('projectFileText', () => {
    it('falls back to Korean', () => {
        expect(projectFileText('ja')).toBe(projectFileText('ko'));
        expect(projectFileText('en').replace('a.sb3')).toMatch(/a\.sb3/);
    });
});
