// Minimal, error-focused config. This repo had NO eslint config at all —
// every lint invocation errored out and reported nothing — which is how an
// undeclared-variable crash (`result` in the approval success path) reached
// production. Scope is deliberately narrow: catch real defects, not style.
import js from '@eslint/js';

const browserGlobals = {
  window: 'readonly', document: 'readonly', navigator: 'readonly',
  fetch: 'readonly', localStorage: 'readonly', sessionStorage: 'readonly',
  console: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly',
  setInterval: 'readonly', clearInterval: 'readonly', requestAnimationFrame: 'readonly',
  cancelAnimationFrame: 'readonly', URL: 'readonly', URLSearchParams: 'readonly',
  Blob: 'readonly', File: 'readonly', FileReader: 'readonly', FormData: 'readonly',
  AbortController: 'readonly', AbortSignal: 'readonly', Image: 'readonly',
  IntersectionObserver: 'readonly', ResizeObserver: 'readonly', MutationObserver: 'readonly',
  performance: 'readonly', crypto: 'readonly', alert: 'readonly', confirm: 'readonly',
  prompt: 'readonly', getComputedStyle: 'readonly', history: 'readonly', location: 'readonly',
  CustomEvent: 'readonly', DOMParser: 'readonly', TextEncoder: 'readonly', TextDecoder: 'readonly',
  structuredClone: 'readonly', queueMicrotask: 'readonly', reportError: 'readonly',
  HTMLElement: 'readonly', Element: 'readonly', Node: 'readonly', KeyboardEvent: 'readonly',
  WebSocket: 'readonly', Notification: 'readonly', atob: 'readonly', btoa: 'readonly',
  Headers: 'readonly', Request: 'readonly', Response: 'readonly',
  createImageBitmap: 'readonly', OffscreenCanvas: 'readonly',
};

// The source uses `eslint-disable-next-line react-hooks/exhaustive-deps`
// comments (written when the repo was edited in environments that had the
// react-hooks plugin). This config doesn't load that plugin, and ESLint
// errors on disable comments naming unknown rules — so register no-op stubs
// to keep the comments valid without pulling in the plugin.
const reactHooksStub = {
  rules: {
    'exhaustive-deps': { create: () => ({}) },
    'rules-of-hooks': { create: () => ({}) },
  },
};

export default [
  { ignores: ['dist/**', 'node_modules/**', 'scripts/**'] },
  // The react-hooks stub above never reports, which would flag every
  // pre-existing disable comment as "unused" — not actionable here.
  { linterOptions: { reportUnusedDisableDirectives: 'off' } },
  {
    files: ['src/**/*.{js,jsx}', 'lib/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: browserGlobals,
    },
    plugins: { 'react-hooks': reactHooksStub },
    rules: {
      ...js.configs.recommended.rules,
      // Defect-catching only — this codebase was never style-linted and a
      // wall of stylistic errors would bury the signal. Without the react
      // plugin, components referenced only in JSX read as unused, so the
      // unused-vars rule stays off in JSX files; no-undef is the rule that
      // catches the "Can't find variable" class and it works everywhere.
      'no-unused-vars': 'off',
      'no-empty': 'off',
      'no-control-regex': 'off',
      // Working production code intentionally rethrows friendlier errors and
      // pre-initialises reassigned locals — not the defect class this config
      // exists to catch, and not worth touching live code over.
      'no-useless-assignment': 'off',
      'preserve-caught-error': 'off',
      'no-undef': 'error',
    },
  },
  {
    files: ['api/**/*.js', 'tests/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...browserGlobals,
        process: 'readonly', Buffer: 'readonly', global: 'readonly', __dirname: 'readonly',
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      // Same defect-only stance as the src block: dead imports and rethrown
      // errors are cleanup, not crashes. Parse errors, no-undef, no-dupe-keys
      // and no-constant-binary-expression stay on and are what caught the
      // real backend bugs (a duplicate declaration that killed an endpoint,
      // and a `Number(x) ?? y` fallback that could never fire).
      'no-unused-vars': 'off',
      'no-empty': 'off',
      'no-control-regex': 'off',
      'no-useless-assignment': 'off',
      'preserve-caught-error': 'off',
    },
  },
];
