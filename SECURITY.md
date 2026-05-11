# Security Policy

OpenADUC sits in front of Active Directory and writes to it on behalf of operators. A vulnerability that lets an unauthenticated user — or an authenticated user with a low-privilege role — read or modify directory data, escalate capabilities, bypass step-up, or tamper with the audit log is taken seriously.

## Supported versions

OpenADUC is pre-1.0. Only the latest tagged release on `main` is supported for security fixes. Older tags will not receive backports.

| Version | Supported          |
| ------- | ------------------ |
| latest  | :white_check_mark: |
| older   | :x:                |

## Reporting a vulnerability

**Please do not report security issues in public GitHub issues, discussions, or pull requests.**

Use one of the following private channels:

1. **GitHub private vulnerability reporting** (preferred):
   <https://github.com/OpenADUC/openaduc/security/advisories/new>

2. **Email**: `security@openaduc.com`
   If you want to encrypt the report, ask in the first message and we'll exchange keys.

Please include, to the extent you can:

- A description of the issue and the impact you believe it has.
- The version / commit SHA you tested against.
- Steps to reproduce, ideally with a minimal proof of concept.
- Any logs, requests, or screenshots that help us reproduce it.
- Whether the issue is already public anywhere.

## What to expect

- **Acknowledgement** within 3 business days.
- **Triage and initial assessment** within 7 business days, including a rough severity rating and whether we'll fix it.
- **Fix and release** target depends on severity: critical issues within 14 days, high within 30 days, lower-severity issues bundled into the next release.
- We'll keep you informed as the fix progresses, and credit you in the release notes and advisory unless you'd prefer to remain anonymous.

We follow a **coordinated disclosure** model: we ask that you give us a reasonable window to ship a fix before publishing details. If you have a hard disclosure deadline (e.g. a conference talk), tell us up front so we can plan around it.

## Scope

In scope:

- The API (`apps/api`) — authentication, authorization, step-up, audit, LDAP write paths, secret handling.
- The web UI (`apps/web`) — XSS, CSRF, session handling, capability checks.
- The shipped Docker images and `install.sh`.
- Default configuration in `.env.example` and `docker-compose*.yml`.

Out of scope (please don't report):

- Findings that require an attacker already in possession of valid AD credentials with broad delegated permissions. OpenADUC is an authenticated admin tool; an operator with full AD write rights can already do anything OpenADUC can do.
- Issues in third-party dependencies that have no realistic exploit path through OpenADUC. Report those upstream.
- Missing security headers on the bundled web container — TLS termination and security headers are the reverse proxy's job. See [docs/security.md](docs/security.md).
- Self-XSS, clickjacking on pages without sensitive state, missing rate limits on read-only endpoints, or other low-impact findings without a demonstrated impact.
- Vulnerabilities in unsupported / un-tagged builds from `main`.

## Safe harbor

We will not pursue legal action against researchers who:

- Make a good-faith effort to comply with this policy.
- Avoid privacy violations, destruction of data, and disruption of others' use of the software.
- Only interact with accounts and directories you own or have explicit permission to test.
- Give us a reasonable window to remediate before public disclosure.

If you're unsure whether something is in scope, ask first — we'd rather hear about it.
