// Browser-facing re-export of the shared filter language (U2). The Capture
// search box and the read API's `q=` parse and evaluate the same grammar; this
// keeps ui/src from reaching into ../../../src by hand, like protocol.ts.
export * from '../../../src/filterLang.js';
