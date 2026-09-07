// Browser-facing re-export of the shared UI protocol. Components and stores
// import types and the pure `entityKey` helper from here so nothing under ui/src
// reaches across the tree into ../../../src by hand.
export * from '../../../src/uiProtocol.js';
