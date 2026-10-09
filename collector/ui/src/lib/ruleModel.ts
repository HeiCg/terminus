// Browser-facing re-export of the interception rule model (U6). The Settings rule
// form validates with exactly the code `PUT /api/rules` runs; this keeps ui/src
// from reaching into ../../../src by hand, like filterLang.ts.
export * from '../../../src/ruleModel.js';
