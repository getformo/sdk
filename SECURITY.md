# Security Policy

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

## Security Practices

- All releases are published with [npm provenance](https://docs.npmjs.com/generating-provenance-statements) via GitHub Actions OIDC
- GitHub Actions are pinned to commit SHAs
- Dependencies are pinned and regularly audited
- A lockfile is maintained and enforced in CI (`--frozen-lockfile`)
