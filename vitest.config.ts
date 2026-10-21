import {defineConfig} from 'vitest/config';

// Only this repository's tests: vendor/scratch-gui has its own.
export default defineConfig({
    test: {include: ['grader/**/*.test.ts']}
});
