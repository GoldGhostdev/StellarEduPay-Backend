# Dependency Security Advisory Triage Process

## Overview

CI runs `npm audit --audit-level=high` for all three packages (root, backend, frontend).
Any **high** or **critical** advisory will fail the build. Dependabot opens weekly PRs for
outdated dependencies.

## When CI Fails with a Vulnerability

1. **Check the advisory**: run `npm audit` locally in the affected package directory.
2. **Apply the fix** if a patched version exists:
   ```bash
   npm audit fix          # non-breaking upgrades only
   npm audit fix --force  # may include semver-major upgrades — review carefully
   ```
3. **Review the diff**: confirm the updated package doesn't introduce breaking changes.
4. **If no fix is available** (zero-day / no upstream patch):
   - Open a GitHub issue tagged `security` with the advisory CVE/ID and affected paths.
   - Assess exploitability in context (e.g. a server-side-only dep used only in tests).
   - If safe to defer, document the exception in `docs/security.md` with the issue link.
   - Do **not** silence the audit without a written justification.

## Dependabot PRs

- Dependabot opens PRs weekly for outdated dependencies.
- Each PR runs the full CI suite including the audit job.
- Merge promptly for patch/minor updates that pass CI.
- Review carefully for major version bumps — check the package CHANGELOG first.

## Severity Reference

| Level    | Action Required        |
|----------|------------------------|
| critical | Fix immediately         |
| high     | Fix before next release |
| moderate | Fix within 30 days      |
| low/info | Fix opportunistically   |
