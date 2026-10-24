# Spec Delta

## REMOVED Requirements

### Requirement: No self-update
**Reason**: The updater can now update itself safely through a dedicated, always-confirmed self-update control that never uninstalls it (see the `plugin-self-update` capability).
**Migration**: The updater's card and detail page show "Update Plugin Updater" instead of the "update it by uninstalling and reinstalling it" hint. "Update all" still skips the updater, and that is now part of `plugin-self-update`'s "Not part of Update all" requirement.
