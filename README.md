# BYOK Manager

Manage custom language models in VS Code Chat without editing JSON by hand. BYOK (Bring Your Own Key) Manager is an independent extension, not an official Microsoft or GitHub product.

Chinese documentation: included as `README.zh-CN.md`.

## Features

- Create or switch Custom Endpoint groups; edit, copy, delete, search and batch-add models.
- Configure Responses, Chat Completions or Messages; set context/output limits, tool calling, vision and reasoning effort.
- Import JSON/JSONC and merge model arrays by ID; export reusable presets without keys or request headers.
- Enter an API key using VS Code's masked input and native secret handling, or reuse an existing local secret reference.
- Back up the current profile's model configuration before writing; restore a backup and eligible settings.
- Optionally apply supported BYOK settings and select an auxiliary model. Existing user settings are preserved unless replacement is explicitly selected.
- English and Simplified Chinese interfaces selected from the VS Code display language; theme follows the editor.

## Getting started

1. Install the extension in VS Code Desktop 1.122 or later. Enable the official Chat/Copilot features with Custom Endpoint support. Use a trusted local window.
2. Open the Command Palette and run **BYOK: Open Model Manager**.
3. Choose an existing group, import a preset or start a new group. Enter an endpoint and the actual model ID and limits provided by your provider. No provider endpoint or models are preconfigured.
4. Use **Enter API Key**, or reuse a key for the same existing group. Only select the unauthenticated option if the endpoint really does not require a key.
5. Validate and choose **Save with Backup**. Review the confirmation, then select the configured model in Chat.

### Example model (replace every placeholder)

```json
{
  "name": "my-provider",
  "vendor": "customendpoint",
  "apiType": "chat-completions",
  "models": [{
    "id": "your-model-id",
    "name": "Your Model",
    "url": "https://gateway.example/v1",
    "toolCalling": true,
    "vision": false,
    "contextWindow": 32768,
    "maxOutputTokens": 4096
  }]
}
```

These capabilities and limits are examples, not verified specifications. Use the real values for your endpoint. Only select capabilities supported by the provider.

## Optional settings

When recommendations are enabled, the extension can set `chat.agentHost.byokModels.enabled`, `chat.byokUtilityModelDefault` and `chat.requestQueuing.defaultAction` if registered. Selecting an auxiliary model additionally proposes the Plan Agent, Inline Chat and two Utility model selectors. No model selector is changed unless a model is chosen. Existing settings remain unchanged by default. Nothing is applied on installation.

## Privacy and compatibility

The extension does not send model requests, collect telemetry, sign into GitHub or bypass authentication. Model requests are sent by VS Code to the configured provider. Prefer HTTPS. The extension uses internal VS Code commands for locating the current profile file and storing a key; these commands are not a stable public API and may change. A successful configuration does not guarantee access to every Chat harness without GitHub sign-in. Organization policy and provider restrictions remain in force.

Backups are local and can contain sensitive existing configuration, including headers, endpoints or previously stored plaintext values. Do not share them. Exported presets omit recognized credential fields and all request headers; review custom fields before sharing. Restoring configuration does not erase secret-store entries, and a referenced key might no longer be valid.

## Development

Node.js 22+ recommended. No runtime dependencies. Run `npm test` and `npm run check`. Press F5 with the included launch configuration to test in an Extension Development Host. `npm run package` builds a local unsigned VSIX and source archive. Marketplace preparation is documented in `RELEASE.md` in the source archive.

This release candidate has automated and simulated-host tests, not verified installation in a real Windows VS Code host or calls to a real endpoint. Use a separate test profile before deployment.

## License

MIT. See `LICENSE.txt`.
