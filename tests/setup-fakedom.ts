// Install Aberdeen's fake DOM globals before any test module (which imports
// Aberdeen) is evaluated. This must be a setupFiles entry (not setupFilesAfterFramework)
// and must not import Aberdeen itself.
// fakedom.js is a side-effect-only module: no deps, installs Object.assign(global, ...).
import '../node_modules/aberdeen/dist/tests/fakedom.js';
