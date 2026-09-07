# Security policy

## Reporting a vulnerability

Please report security vulnerabilities privately. Do **not** open a public issue.

Use GitHub's private vulnerability reporting for this repository:
**Security → Report a vulnerability** (Security Advisories) at
`https://github.com/HeiCg/terminus/security/advisories/new`.

Include the version or commit, your platform, reproduction steps, and the impact
you observed. We aim to acknowledge a report within a few days and will keep you
updated as we investigate and fix.

## Scope

Terminus is a developer tool that binds capture listeners to the LAN and a web UI
to loopback. In scope, for example:

- The UI or any capture data reachable from the LAN rather than loopback only.
- Bypassing the device-token or TLS authentication on the capture channels.
- Bypassing the DNS-rebinding `Host`/`Origin` checks on the loopback server.
- A pairing flaw that lets an unauthorized device pair, or leaks the device token.
- Capture data written outside the state directory, or secrets that survive
  redaction of known auth headers/params.
- The `admin-token` file being written readable beyond the local user (it must be
  `0600`), or the admin token being exposed off-loopback.

Out of scope:

- Anything requiring an already-compromised host or physical access to the machine
  (capture data is held in memory unencrypted by design).
- Trusting the optional proxy CA on a device — this is an explicit MITM opt-in.
- The QR containing the device token — this is documented behavior; treat the
  Devices screen as a secret.
- A stale `admin-token` file left after a crash (not a clean shutdown) — the token
  rotates every boot, so the leftover authenticates nothing against the next run.

See [docs/security.md](docs/security.md) for the full trust model.
