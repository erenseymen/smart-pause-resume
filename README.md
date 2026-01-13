# smart-pause-resume

Guarantee that **only one MPRIS player** is "Playing" at a time on your Linux desktop. When you start or resume a media player, all others are auto-paused. When you pause/stop/close the current player, the most recently paused one resumes. Each player window (bus name) is treated independently.

**Available in two versions:**
- 🐚 **Bash Script** - Universal solution for any Linux desktop
- 🎨 **GNOME Extension** - Native integration for GNOME Shell 46+

Bash Script is created with ChatGPT o3. ([conversation](https://chatgpt.com/share/6854a758-aec0-8006-bedf-baf606a9ce59))

GNOME Extension is created with Claude Opus 4.5.

## Features
- **Auto-pause** all other players when one starts or resumes
- **Resume** the most-recently paused player when the foreground one is paused, stopped, or quits
- **Distinct** handling for every MPRIS bus-name (e.g. `vlc.instance-42`)
- **Stack-based**: If you stop/close a player, it is removed from the stack forever
- **No duplicates** in the paused-player stack (LIFO)

---

## 🎨 GNOME Shell Extension (Recommended for GNOME users)

A native GNOME Shell extension with Quick Settings integration and no external dependencies.

### Requirements
- GNOME Shell 46, 47, 48, or 49
- No external dependencies

### Installation

1. Navigate to the extension directory:
   ```sh
   cd smart-pause-resume@gnome-extension
   ```

2. Compile schemas:
   ```sh
   glib-compile-schemas schemas/
   ```

3. Install the extension:
   ```sh
   mkdir -p ~/.local/share/gnome-shell/extensions
   cp -r . ~/.local/share/gnome-shell/extensions/smart-pause-resume@erenseymen.github.io
   ```

4. Restart GNOME Shell:
   - **Wayland**: Log out and log back in
   - **X11**: Press `Alt+F2`, type `r`, and press Enter

5. Enable the extension:
   ```sh
   gnome-extensions enable smart-pause-resume@erenseymen.github.io
   ```

### Configuration

The extension adds a toggle directly to your GNOME Quick Settings panel for easy access. Any additional settings (like resume delay) can be modified via `gsettings`.

**See [smart-pause-resume@gnome-extension/README.md](smart-pause-resume@gnome-extension/README.md) for detailed documentation.**

---

## 🐚 Bash Script (Universal)

A standalone bash script that works on any Linux desktop environment.

### Requirements
- Bash 4+
- [Playerctl](https://github.com/altdesktop/playerctl) ≥2.2

### Installation
1. Copy `smart-pause-resume` to a directory in your `$PATH` (e.g. `~/bin/`):
   ```sh
   cp smart-pause-resume ~/bin/
   chmod +x ~/bin/smart-pause-resume
   ```
2. (Optional) Install as a systemd user service:
   - Copy `smart-pause-resume.service` to `~/.config/systemd/user/`
   - Edit the `ExecStart` path in the service file if needed
   - Enable and start the service:
     ```sh
     systemctl --user enable --now smart-pause-resume.service
     ```

### Usage
Just run the script in the background, or use the systemd service. It will listen for MPRIS events and manage playback automatically.

### Gnome Integration: Toggle Button
Gnome users can add a convenient toggle button for smart-pause-resume using the [Custom Command Toggle](https://extensions.gnome.org/extension/7012/custom-command-toggle/) extension:

- **Toggle ON command:**
  ```sh
  systemctl --user start smart-pause-resume.service
  ```
- **Toggle OFF command:**
  ```sh
  systemctl --user stop smart-pause-resume.service
  ```

This adds a switch to your Gnome panel, letting you easily enable or disable the smart-pause-resume service without using the terminal.

### Pause All Players Manually

If you want to pause all MPRIS players at once, use the included `pause-all` script:

```sh
./pause-all
```

- If the `smart-pause-resume` service is running, it will be temporarily stopped, all players will be paused, and then the service will be restarted.
- If the service is not running, it simply pauses all players.

This is useful if you want to quickly pause everything regardless of which player is active.

---

## How it works
- Listens for MPRIS events using D-Bus (GNOME extension) or `playerctl` (bash script)
- Maintains a stack of paused players
- Only resumes players that were auto-paused by the script/extension
- Ignores players stopped/paused by the user

## License
MIT
