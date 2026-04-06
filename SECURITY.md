# Security Policy

For the full Formo security overview, see [formo.so/security](https://formo.so/security) and the [Security documentation](https://docs.formo.so/security).

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.x.x   | :white_check_mark: |
| < 1.0   | :x:                |

## Reporting a Vulnerability

If you discover a security vulnerability in `@formo/analytics`, please report it responsibly.

**Do not open a public GitHub issue for security vulnerabilities.**

Instead, please email **security@formo.so** with:

- A description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

We will acknowledge receipt within 48 hours and aim to provide a fix within 7 days for critical issues.

## Security Architecture

### Transport Security

All event data is transmitted exclusively over HTTPS/TLS to `https://events.formo.so`. The API endpoint is hardcoded with the `https://` scheme — there is no HTTP fallback and no configuration that downgrades to plaintext transport.

When using a custom `apiHost` (proxy), it is the integrator's responsibility to ensure the proxy endpoint also uses HTTPS.

### Subresource Integrity (SRI)

When loading the SDK via a `<script>` tag from a CDN (e.g. unpkg), you should use [Subresource Integrity](https://developer.mozilla.org/en-US/docs/Web/Security/Subresource_Integrity) to ensure the script has not been tampered with in transit:

```html
<script
  src="https://unpkg.com/@formo/analytics@1.0.0/dist/index.umd.min.js"
  integrity="sha384-<HASH>"
  crossorigin="anonymous"
></script>
```

SRI hashes for each release are published alongside the package. See the [SRI documentation](https://docs.formo.so/security/sri) for per-version hashes and verification instructions, or check the [GitHub releases page](https://github.com/getformo/sdk/releases).

**Using the npm package** (`@formo/analytics` via npm/pnpm/yarn) avoids CDN delivery risks entirely, since the package is verified by the registry and lockfile.

### Content Security Policy (CSP)

The SDK is compatible with strict Content Security Policies. The minimum required directives are:

```
script-src 'self';
connect-src 'self' https://events.formo.so;
```

If using a custom `apiHost` (first-party proxy), add your proxy domain to `connect-src`:

```
connect-src 'self' https://events.formo.so https://your-proxy.example.com;
```

If loading via CDN, add the CDN origin to `script-src`:

```
script-src 'self' https://unpkg.com;
```

The SDK does **not** require `unsafe-eval` or `unsafe-inline`. It uses no `eval()`, `innerHTML`, `document.write()`, or dynamic script injection. All network communication uses the standard `fetch()` API.

See the [CSP documentation](https://docs.formo.so/security/csp) for detailed configuration guidance.

### Provider Wrapping (Wallet Event Tracking)

The SDK can optionally wrap `provider.request()` on EIP-1193 wallet providers to track signature and transaction events. This is a read-only observation layer:

- **Requests are always forwarded unchanged** to the original `provider.request()` — parameters and return values are never modified
- **Tracking is fire-and-forget** — event capture runs in an async IIFE and never blocks or delays the wallet call
- **Errors are re-thrown unchanged** — if the wallet provider throws (e.g. user rejects), the error propagates to the caller exactly as it would without the SDK
- **Wrapping is idempotent** — the SDK checks for a `WRAPPED_REQUEST_SYMBOL` marker to prevent double-wrapping
- **Wrapping is graceful** — if `provider.request` is immutable (e.g. frozen by the wallet), the SDK silently skips wrapping

#### Opting Out of Provider Wrapping

Provider wrapping can be fully bypassed in three ways:

1. **Disable all autocapture:**
   ```ts
   FormoAnalytics.init(writeKey, { autocapture: false });
   ```
   No wallet events are tracked. `provider.request()` is never touched.

2. **Disable only signature and transaction tracking:**
   ```ts
   FormoAnalytics.init(writeKey, {
     autocapture: { signature: false, transaction: false }
   });
   ```
   Connect, disconnect, and chain-change events still work via standard EIP-1193 event listeners (`accountsChanged`, `chainChanged`, `connect`, `disconnect`) — these do **not** wrap `provider.request()`.

3. **Use Wagmi integration:**
   ```ts
   FormoAnalytics.init(writeKey, { wagmi: { config } });
   ```
   In Wagmi mode, the SDK hooks into Wagmi's state management (`config.subscribe()`) and mutation cache instead of wrapping any provider. `provider.request()` is never modified. This is the recommended integration for React/Next.js apps using Wagmi v2.

### Cookie Security

- Consent cookies use `Secure` (HTTPS-only) and `SameSite=Strict` attributes
- Cookie names are derived from a SHA-256 hash of the project write key, providing project isolation
- Session cookies (wallet detection, current URL) are scoped to the current host only
- The `crossSubdomainCookies` option (default `true`) controls whether identity cookies are set on the apex domain; set to `false` to restrict to the current host

### Consent Management

The SDK respects user consent preferences:

- `formo.optOutTracking()` — sets a persistent consent flag and stops all event collection
- `formo.optInTracking()` — clears the opt-out flag
- `formo.hasOptedOutTracking()` — check current consent status

Consent flags are stored in project-specific cookies and persist across sessions.

## Data Collection

### What the SDK Collects

| Category | Data | When |
|----------|------|------|
| **Page** | URL, title, path, referrer, UTM parameters | Every page view |
| **Browser** | User agent, browser name, locale, timezone, screen dimensions | Every event (as context) |
| **Wallet** | Wallet address, chain ID, provider name | On connect/identify |
| **Transaction** | Status, chain ID, address, tx hash, calldata, function name/args | On `eth_sendTransaction` (if autocapture enabled) |
| **Signature** | Status, chain ID, address, message content, signature hash | On `personal_sign` / `eth_signTypedData_v4` (if autocapture enabled) |
| **Identity** | Anonymous ID (UUID), optional user ID | Every event |

### Controlling Data Collection

- **Disable EVM tracking entirely:** `{ evm: false }`
- **Disable specific event types:** `{ autocapture: { transaction: false, signature: false } }`
- **Exclude specific hosts/paths/chains:** `{ tracking: { excludeHosts: [...], excludePaths: [...], excludeChains: [...] } }`
- **Use a first-party proxy:** `{ apiHost: 'https://your-domain.com/ingest' }` — route events through your own infrastructure for inspection and control

## Supply Chain Security

- All releases are published with [npm provenance](https://docs.npmjs.com/generating-provenance-statements) via GitHub Actions OIDC — each package can be traced back to the exact source commit and CI workflow
- GitHub Actions are pinned to commit SHAs (not mutable tags)
- Dependencies are pinned and regularly audited
- A lockfile is maintained and enforced in CI (`--frozen-lockfile`)
- The SDK has minimal dependencies — core cryptographic operations use `ethereum-cryptography`
