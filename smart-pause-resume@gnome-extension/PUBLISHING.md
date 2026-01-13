# Publishing Guide for Smart Pause Resume

This guide explains how to package and publish the **Smart Pause Resume** GNOME extension.

## Prerequisites

- You need a [GNOME Extensions account](https://extensions.gnome.org/).
- Ensure `metadata.json` version and shell support are up to date.

## Step 1: Prepare the Package

The extension must be packaged as a `.zip` file containing only the necessary runtime files.

### Files to Include:
- `extension.js`
- `metadata.json`
- `schemas/org.gnome.shell.extensions.smart-pause-resume.gschema.xml` (Do **NOT** include `gschemas.compiled`)

### Command Line Packing:

Run the following command from inside the `smart-pause-resume@gnome-extension` directory:

```bash
# Remove old build if exists
rm -f smart-pause-resume.zip

# Create new zip
zip -r smart-pause-resume.zip . -x "*.git*" -x "schemas/gschemas.compiled" -x "*.md" -x "PUBLISHING.md"
```

## Step 2: Validation

Before uploading, you can validate the extension locally using `gnome-extensions` tool (if available):

```bash
gnome-extensions pack --force .
# This usually creates a zip in proper format, checking metadata.
```

*Note: The manual zip method in Step 1 is often safer to ensure you control exactly what goes in.*

## Step 3: Upload

1. Go to [extensions.gnome.org/upload](https://extensions.gnome.org/upload/).
2. Select the `smart-pause-resume.zip` you just created.
3. Click **Upload Extension**.

## Step 4: Review Process

- After upload, your extension will go into a "Review" queue.
- A human reviewer will check your code for security and performance issues.
- You can check the status on your [Extensions account page](https://extensions.gnome.org/local/).

## Common Rejection Reasons to Avoid:
- **Blocking the Main Loop**: Use async/await or callback patterns for DBus (Extension.js is already optimized for this).
- **Leaking Resources**: Ensure `disable()` cleans up everything (signals, timeouts, UI).
- **Console Spam**: Remove debug logs before release (minimal logging is okay).
