# Security

BYOK Manager manages local model configuration. It does not make network calls, collect telemetry or send secrets to a backend. The key is entered through a masked VS Code input and held in extension memory until an explicitly confirmed save. Native secret-handling commands are internal and may change; compatibility checks are not a guarantee of security or support in every host.

Treat configuration backups as sensitive. Exports remove recognized credentials and headers but cannot recognize all possible secrets in custom fields. Use HTTPS and review every endpoint in the confirmation dialog. Do not share logs or screenshots containing credentials. Report potential vulnerabilities privately to the maintainer through the repository's private reporting channel when configured. Do not disclose live credentials in public issues.
