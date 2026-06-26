# Changelog

All notable changes to Stream Resilience Lab will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- GitHub Actions workflows for automated multi-platform builds
- CI workflow for continuous integration testing
- Nightly build workflow for automated development builds
- Cleanup workflow for artifact management
- Cross-platform build scripts with command-line arguments
- Comprehensive documentation for GitHub Actions and release process
- Desktop debugger with visual trace timeline

### Changed
- Build commands now support platform-specific builds (`--win`, `--mac`, `--linux`)
- Updated documentation with CI/CD integration details

### Fixed
- Cross-platform build compatibility issues

## [0.1.0] - 2026-06-25

### Added
- Initial release of Stream Resilience Lab
- Fault provider mock service with 20 failure scenarios
- Resilience runner CLI with SDK integration
- Support for OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages APIs
- Structured trace events for debugging
- Smoke test matrices (quick and full)
- Desktop debugger application (Electron + Vite + React)

### Scenarios
- S01: normal - baseline completion
- S02: slow - slow stream handling
- S03: rate-limit-retry-after - rate limit with retry-after
- S04: overloaded-retry-after - overload with retry-after
- S05: server-error - server error retry
- S06: midstream-close - partial output handling
- S07: half-sse-frame - malformed stream detection
- S08: silent-hang - idle timeout handling
- S09: heartbeat-only - heartbeat-only stream handling
- S10: half-tool-json - incomplete tool call blocking
- S11: flood - high-volume chunk consumption
- S12: bounded-queue-overflow - stream backpressure handling
- S13: consumer-drop - consumer cancellation handling
- S14: fallback-recovery - fallback model recovery
- S15: circuit-breaker-open - circuit breaker pattern
- S16: provider-cooldown - provider cooldown pattern
- S17: background-overloaded - background task dropping
- S18: context-overflow - context compaction requirement
- S19: session-lock-conflict - session concurrency blocking
- S20: max-turns-exceeded - max turn loop prevention

---

## Version History

The version history follows this format:

```markdown
## [Version] - YYYY-MM-DD

### Added
- New features

### Changed
- Changes to existing features

### Deprecated
- Features that will be removed in future versions

### Removed
- Removed features

### Fixed
- Bug fixes

### Security
- Security fixes
```

---

[Unreleased]: https://github.com/your-username/stream-resilience-lab/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/your-username/stream-resilience-lab/releases/tag/v0.1.0
