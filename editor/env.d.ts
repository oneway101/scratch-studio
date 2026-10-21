// TurboWarp's sources are JavaScript without type declarations.
declare module '@gui/*';

// Replaced at build time by webpack's DefinePlugin.
declare const process: {env: {STUDIO_ALLOWED_ORIGINS?: string}};

declare module 'scratch-vm';
declare module 'scratch-render';
declare module '@turbowarp/scratch-svg-renderer';
declare module 'scratch-vm/src/dispatch/central-dispatch';
