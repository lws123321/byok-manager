# Testing / 测试

## Edition acceptance (0.6.0)

With the official CLI installed, `npm test` also verifies the raw checkout packaging guard: `vsce ls --no-dependencies` must expose only the root manifest and README, and direct packaging must fail without creating a VSIX. The test uses synthetic private inputs and an existing internal artifact. `npm run package:marketplace` is the separate, supported positive path.

Windows / VS Code Desktop 1.147.0: installed the original internal 0.4.2 VSIX and upgraded it in place to 0.6.0 in an isolated installation directory. Independently installed both 0.6.0 VSIX files in another isolated desktop host and verified distinct views, commands and reusable editor panels. No provider requests or real credentials were used.

`node test/compare-legacy.js <trusted-old.vsix> <trusted-internal-candidate.vsix>` compares both packaged implementations with a simulated host and temporary in-memory storage. It checks the ordered three-model preset, all eight settings and exact values, the four command routes, fixed selectors when a model is renamed/missing/in another group, restoration of an old backup, and lock compatibility. Requires Python 3 for archive reading; it is not a runtime dependency. Use trusted local releases only; the comparison executes their CommonJS code.

Use `npm test` for shared behavior and edition-specific regression tests. Run `npm run build:public` and `npm run build:enterprise` from the same checkout. For release acceptance run `npm run package:all`; successful staging alone is not a successful package audit. Check the version, publisher/name, command IDs, locale files and walkthrough for each final VSIX. Never share the private archive as a test fixture.

For desktop coexistence, run `node test/run-host-smoke.js --installed <public.vsix> <enterprise.vsix>`. The launcher uses an isolated profile and extension directory, installs both files, opens both sidebars and managers, and exercises repeat-open. This checks real registration, not provider connectivity or live credentials. Also compare the internal package against the authorized previous internal release before distributing an upgrade. A private-input mismatch or missing configuration must block that edition; synthetic fixtures only verify the mechanism.

## Previous 0.5.1 verification (Windows, 2026-11-26)

- Actual VS Code Desktop 1.147.0: opened the native sidebar, activated its first tree item, ran diagnostics and reopened the same Webview tab. The CLI also installed 0.5.0 and upgraded it to 0.5.1 under `asong-dev.byok-manager` in an isolated installation directory.
- Chromium 155: English and Simplified Chinese × light, dark and high-contrast variable sets × 320/400/540/720/850/1024/1200/1600px. Checked all model fields, accessible actions, horizontal overflow, independent scrolling and footer position. Exercised model CRUD on the 320px layout. The message bridge and colors in these checks were simulated.
- The final public archive is checked separately from the development host. Native secret writes, backup restoration and conflict handling use simulated-host fixtures, not a user's credentials or configuration.

## Unit and simulated host

Run `npm test` and `npm run check` with Node.js 22+. The Node suite covers JSONC, model validation, imports, settings, native command contracts, key-reference reuse, backup integrity and concurrent writes. The simulated host uses temporary files and a fake secret store. It does **not** certify that a specific version of Copilot accepts the native secret command.

## Desktop host

Run `node test/run-host-smoke.js` with VS Code Desktop installed. This launches a real Extension Development Host against the checkout using separate temporary user-data and extension directories. It tests Activity Bar/view activation, commands, diagnostics and revealing the same editor tab on repeated open. Do not run write/restore experiments against your normal profile.

## Webview layout and interactions

`node test/browser-smoke.js` exercises the shipped HTML, CSS and script with synthetic model data in Chromium. Set `PLAYWRIGHT_CORE_PATH` to an external installation of `playwright-core` and, if needed, `CHROMIUM_PATH` to the browser executable. Neither is an extension dependency. This harness uses a mocked VS Code message bridge and theme variables; it is not a second desktop-host test.

Regenerate the six documentation PNGs with `node test/browser-smoke.js --screenshots` using the same optional browser dependencies. These are captures of the current renderer with fictional data, not recordings of a signed-in desktop profile. The guide itself loads the packaged images offline.

For manual checks, switch between English and Simplified Chinese, try light/dark, custom and high-contrast themes, and split the editor. At 320px, verify that protocol, token limits, capabilities and actions remain readable; at 1600px, verify table alignment. With many models, scroll to the last item, tab to the footer, cancel a save, and check that the unsaved indicator remains. Also try restore with the editor closed.

## Native user guide

The seven-step guide is a contributed Getting Started walkthrough, not a webview. For interactive acceptance, use a clean, trusted local profile with installation walkthroughs enabled; install from the Extensions UI and observe the guide. Close the guide before reloading the window or upgrading so a restored editor tab is not mistaken for a fresh popup. No BYOK command should open a guide on startup. If the host suppresses onboarding, use **BYOK: Open User Guide** or the sidebar entry.

On Windows with VS Code Desktop 1.147.0, a fresh in-window Public VSIX install opened the guide when Getting Started was ready and the window had focus. A cold-window install did not. The 0.5.0 → 0.5.1 upgrade introduced the guide and showed it; the 0.5.1 → 0.6.0 upgrade retained the same guide ID and did not reopen it. No guide appeared during the seven-second observations after a restart with the tab explicitly closed or on first launch after an offline CLI install.

In the installed Public VSIX, the Command Palette reopened the guide twice. With English and Simplified Chinese display languages, all seven step titles matched, localized images decoded, and the walkthrough button opened the manager. These are local-VSIX onboarding checks, not Marketplace installation, provider connectivity, or a rerun of the separate two-edition coexistence test.

Repeat in English and Simplified Chinese. Open the guide twice, follow **Open Model Manager**, and check the three illustrated operations: provider setup, model editing and saving. Confirm that reading a step, opening the editor, cancelling a save or receiving a validation error is not presented as a successful configuration write. A successful save is not evidence of a successful provider request.

To exercise the packaged guide on Windows, set `PLAYWRIGHT_CORE_PATH` as above and run `node test/install-onboarding.js dist/public/asong-dev.byok-manager-0.6.0.vsix dist/asong-dev.byok-manager-0.5.1.vsix`. Both files must have the same publisher. Set `BYOK_ZH_PACK` to a local Simplified Chinese language pack directory to include desktop language verification. This uses separate temporary profiles, not the user's normal VS Code window.

## Release candidate

Use `npm run package:marketplace` with the same release publisher as the previous public VSIX (see `RELEASE.md`). Check the final archive, not just the staging folder:

```sh
python test/verify_vsix.py dist/marketplace/asong-dev.byok-manager-0.6.0.vsix asong-dev.byok-manager 0.6.0 --repository https://github.com/lws123321/byok-manager
```

`test/verify_vsix.py` is a compatibility CLI for the Node verifier; run it from a checkout matching the candidate version. For a local package use its path in `dist/public/` or `dist/enterprise/` and omit `--repository` unless the manifest actually has that release override. Enterprise comparison needs the matching private input. The verifier never installs, executes or publishes the archive.

- `auditSource(root)` (CLI: `node scripts/audit.js source`) requires a Git working tree. It checks paths and staged blobs from the index, then working copies and untracked public files. A broad ignore rule cannot hide ordinary source, docs, or images; ignored private inputs, dependencies and build outputs are not public inputs. A force-added private config or artifact fails. The audit does **not** scan Git history, remote refs, backup files outside the repository, or another process changing files during the check.
- `verifyVsix(path, edition, expectedPkg, {root, stage, files})` checks the final ZIP's local and central records, deflate streams, CRCs, exact extension inventory, expected manifest, edition, asset paths/MIME types, and both localized walkthroughs. `stage` pins the payload bytes (except equivalent package JSON and the known Marketplace README URL rewrite); `files` pins the relative inventory. The build/release callers supply both. When calling the API without a stage, a correct inventory is **not** evidence of byte-for-byte provenance. The ZIP reader accepts only ordinary store/deflate members: no comments, extra fields, links, ZIP64 or alternate paths; limits are 512 members, 16 MiB per member and 128 MiB in total.
- Both editions reject known credential formats. Public source/VSIX also reject known private markers. The auditor alone may read ignored `editions/enterprise.local/config.json` (or `BYOK_ENTERPRISE_CONFIG`) for distinctive names, hosts, model IDs and instruction strings; missing default config is supported. For other distinctive literals add an ignored `editions/enterprise.local/audit-markers.json` JSON array of strings (minimum three characters); keep this file out of the stage and out of Git. Marker scanning is not arbitrary secret detection, OCR, a cryptographic signature, or a substitute for reviewing code and images.

Real API keys, provider calls, sign-in flows and organization policies are outside the automated tests. For compatibility acceptance, use a dedicated test key and profile; check that the native vault handles the key, saving reuses it, backup/restore preserves settings, and an actual chat reaches the intended provider. Never attach keys, private endpoints or unredacted backups to test reports.
