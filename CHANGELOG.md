# Changelog

## 0.6.0

- A single release version now builds two editions from the same manager, secret handling, backup logic and walkthrough framework. Public keeps the existing Marketplace identity, generic defaults and user-selected auxiliary model.
- The internal distribution takes its identity, presets, settings and localized guide from a private build input. Its preset action is compiled into that edition only; configuring a build does not write to a user's VS Code profile.
- Saving and restoring now coordinate across editions for the same profile. Backups remain in each extension’s own directory, and the previous release’s lock is still honored.
- Packaging now uses isolated staging and checks the release archive before delivery. The Marketplace workflow is restricted to Public.

## 0.5.1

- Follow a seven-step English or Simplified Chinese guide from provider setup to a first real chat. The guide includes screenshots, explains token limits and auxiliary model choices, and covers common provider errors, diagnostics and backup recovery.
- Find onboarding in VS Code Getting Started, in the BYOK sidebar or with **BYOK: Open User Guide**.
- Open the existing model editor, restore a backup or run diagnostics from the new BYOK Manager Activity Bar view. The original Command Palette entries remain available.
- Model rows now reflow in split editors without hiding protocols, capabilities or token limits. Inputs, row actions and separators use component-specific VS Code theme colors.
- Save with Backup and Restore Backup stay visible while the form scrolls. The save area reports draft changes, pending operations and results without changing the backup format or native secret handling.

## 0.5.0 – public release candidate

- Generic Custom Endpoint model groups; no bundled organization endpoints or models.
- English and Simplified Chinese UI, commands and native messages.
- User-selected auxiliary model for optional recommended settings; no hardcoded model or commit-message instructions.
- Marketplace PNG icon, bilingual documentation, release packaging script and support/security notes.
- Compact model table, visual editing, JSON merge, local backup/restore and key-reference handling retained.
- New public extension name `byok-manager`; earlier internal editions use a different extension identity.
