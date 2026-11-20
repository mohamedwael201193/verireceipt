// Type shims for the x402 fallback packages.
//
// @x402/fetch and @x402/evm ship ESM-only type declarations that this
// repo's CommonJS `moduleResolution: node` tsconfig cannot resolve, and
// @x402/evm's types pull in `ox` sources that reference DOM globals
// (window) absent from the Node lib. The fallback path loads both
// packages with dynamic `import()` at runtime only, so these loose
// declarations keep the typechecker green without changing runtime
// behaviour. If the packages are not installed, the dynamic import
// throws at runtime and the client reports the fallback as unavailable.

declare module "@x402/fetch" {
  export const wrapFetchWithPaymentFromConfig: (
    fetchImpl: typeof fetch,
    config: Record<string, unknown>,
  ) => typeof fetch;
}

declare module "@x402/evm" {
  export class ExactEvmScheme {
    constructor(account: unknown);
  }
}
