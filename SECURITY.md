# Security Policy

## Supported Versions

| Version | Supported          |
|---------|--------------------|
| 3.x     | ✅ Active support   |
| < 3.0   | ❌ Not supported    |

## Reporting a Vulnerability

If you discover a security vulnerability in pi-listen, **please report it responsibly.**

### How to Report

1. **Do NOT open a public GitHub issue** for security vulnerabilities
2. Email: Open a private security advisory on GitHub via the [Security tab](https://github.com/codexstar69/pi-listen/security/advisories/new)
3. Include:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact assessment
   - Suggested fix (if any)

### Response Timeline

- **Acknowledgment:** Within 48 hours
- **Assessment:** Within 7 days
- **Fix release:** Within 30 days for confirmed vulnerabilities

### Scope

The following are **in scope** for security reports:

| Area | Examples |
|------|----------|
| Audio handling | Temp file races, audio data leakage |
| Config files | Credential exposure, unsafe deserialization |
| Subprocess spawning | Command injection via SoX arguments |
| WebSocket streaming | Data integrity, connection hijacking |
| Dependencies | Known CVEs in direct dependencies |

The following are **out of scope:**

| Area | Reason |
|------|--------|
| Provider API key exposure | User-managed credential, documented in setup |
| Denial of service via long recordings | Local-only, self-inflicted (120s auto-stop cap) |

## Security Design Principles

pi-listen follows these security principles:

### 1. Cloud speech services
Audio is streamed to Deepgram for transcription via encrypted WebSocket
(`wss://`). When Gemini Talk TTS is selected, batched assistant response
fragments are sent to the Gemini Developer API over HTTPS and the returned PCM
is buffered briefly in memory before ephemeral playback. Refer to each
provider's current data-processing terms for remote retention behavior.

### 2. No Telemetry
pi-listen does not collect, transmit, or store any usage data, analytics, or telemetry.

### 3. Minimal Attack Surface
- No persistent storage of audio recordings
- No network listeners (audio streams outbound only)
- SoX subprocess captures audio ephemerally (no temp files)
- Recording auto-stops after 120 seconds

### 4. Defense in Depth
- API keys are resolved from their documented environment or credential files, never logged, and never included in request URLs
- Env-derived `DEEPGRAM_API_KEY` values are runtime-only and are not persisted back into `~/.pi/agent/settings.json`
- Gemini keys from `GEMINI_API_KEY` or `~/.authinfo` are never persisted in voice settings
- Error responses do not expose stack traces or internal paths
- Connection timeout (10s) and stale session watchdog (15s) prevent hung resources
- Session corruption guard prevents overlapping recording sessions

### 5. Principle of Least Privilege
- Runs as the current user (no root required)
- Credential-file access is limited to the documented `~/.authinfo` fallback
- Audio data flows to Deepgram only when cloud STT is selected; assistant text flows to Google only when Gemini Talk TTS is selected

## Recent Security Audit

**Date:** 2026-03-12 (pre-v3 codebase -- daemon and local backends have since been removed)
**Method:** Adversarial bug-hunter pipeline (Recon → Hunter → Skeptic → Referee)
**Scope:** Full codebase at time of audit (7 source files, 2948 lines)
**Results:**

| Metric | Count |
|--------|-------|
| Findings reported | 13 |
| Confirmed bugs | 8 |
| Security-relevant | 1 (CWE-200, fixed) |
| Fixed | 6 |
| Remaining (low severity) | 2 |

See `.bug-hunter/report.md` for the full audit report. Note: the v3 rewrite removed the daemon, local backends, and Unix socket -- the primary attack surface identified in that audit no longer exists.
