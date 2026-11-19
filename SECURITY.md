# Security policy

## Supported versions

Only the latest release (currently 0.1.x, pre-release) receives fixes.

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private vulnerability reporting
("Security" → "Report a vulnerability") on this repository. Include affected version, steps to
reproduce, and impact. You can expect an acknowledgement within 7 days.

Particularly relevant classes of issue:

- escaping the project directory (path traversal, symlinks, crafted file names),
- executing code through a tool argument or a model spec,
- credential leakage in logs, errors, stored metadata or tool output,
- bypassing budget limits or approval checks,
- sending credentials to an unintended host.

The security model and its stated limits (for example, Blender is not sandboxed) are documented in
[docs/security.md](docs/security.md).
