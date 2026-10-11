// Build-only: the published compile (tsconfig.build.json) keeps configs/*.json out of the program,
// so the emitted JS keeps its JSON imports and the configs ship next to lib/ unchanged.
declare module '*.json' {
  const value: unknown;
  export default value;
}
