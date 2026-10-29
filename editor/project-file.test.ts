import {describe, expect, it} from 'vitest';
import {isProjectFileName, projectFileName, projectFileText} from './project-file';

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

describe('projectFileName', () => {
    it('keeps the opened file name as .sb3', () => {
        expect(projectFileName('game.sb3', 'ko')).toBe('game.sb3');
        expect(projectFileName('우리 게임.sb2', 'ko')).toBe('우리 게임.sb3');
        expect(projectFileName('OLD.SB', 'en')).toBe('OLD.sb3');
    });
    it('names a project the site opened by locale', () => {
        expect(projectFileName(null, 'ko')).toBe('내 작품.sb3');
        expect(projectFileName(null, 'en')).toBe('My Project.sb3');
        expect(projectFileName('.sb3', 'ko')).toBe('내 작품.sb3');
    });
});
