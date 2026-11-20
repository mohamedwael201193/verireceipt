// Ambient DOM globals required ONLY because viem's bundled `ox`
// dependency ships .ts sources (not .d.ts) for its WebAuthn modules,
// and this repo's tsconfig has no DOM lib. These declarations exist
// solely so tsc can check those third-party sources; Desk code must
// not use `window` or WebAuthn types (server-side Node only).
// If viem/ox ever ship proper .d.ts for these modules, delete this file.

declare const window: any;
declare type AuthenticatorAttestationResponse = any;
declare type AuthenticatorAssertionResponse = any;
declare type AuthenticationExtensionsClientOutputs = any;
