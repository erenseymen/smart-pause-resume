# Smart Pause Resume - GNOME Shell Extension

A GNOME Shell extension that ensures **only one MPRIS media player** is "Playing" at a time. When you start or resume a media player, all others are auto-paused. When you pause/stop/close the current player, the most recently paused one resumes.

## Features

- **Auto-pause** all other players when one starts or resumes
- **Resume** the most-recently paused player when the foreground one is paused, stopped, or quits
- **Distinct** handling for every MPRIS bus-name (e.g. `vlc.instance-42`)
- **Stack-based**: If you stop/close a player, it is removed from the stack forever
- **No duplicates** in the paused-player stack (LIFO)
- **Configurable**: Enable/disable functionality and adjust resume delay via preferences

## Requirements

- GNOME Shell 46, 47, or 48
- No external dependencies (uses native D-Bus communication)

## Installation

### From Source

1. Clone or download this repository
2. Compile the GSettings schemas:
   ```bash
   cd smart-pause-resume@gnome-extension
   glib-compile-schemas schemas/
   ```
3. Copy the extension to your local extensions directory:
   ```bash
   mkdir -p ~/.local/share/gnome-shell/extensions
   cp -r smart-pause-resume@gnome-extension ~/.local/share/gnome-shell/extensions/smart-pause-resume@erenseymen.github.io
   ```
   
   Or create a symlink for development:
   ```bash
   ln -sf /path/to/smart-pause-resume@gnome-extension ~/.local/share/gnome-shell/extensions/smart-pause-resume@erenseymen.github.io
   ```

4. Restart GNOME Shell:
   - On X11: Press `Alt+F2`, type `r`, and press Enter
   - On Wayland: Log out and log back in

5. Enable the extension:
   ```bash
   gnome-extensions enable smart-pause-resume@erenseymen.github.io
   ```

## Configuration

Open the extension preferences to configure:

```bash
gnome-extensions prefs smart-pause-resume@erenseymen.github.io
```

Or access via GNOME Extensions app.

### Settings

- **Enable Auto-Pause/Resume**: Toggle the extension functionality on/off
- **Resume Delay**: Time to wait (in milliseconds) before confirming a pause/stop event and resuming another player. Default: 600ms

## How It Works

The extension monitors the D-Bus session bus for MPRIS-compliant media players:

1. **Player Detection**: Watches for `org.mpris.MediaPlayer2.*` bus names
2. **Status Monitoring**: Subscribes to `PlaybackStatus` property changes
3. **Auto-Pause Logic**: When a player starts playing, all other playing players are paused
4. **Resume Logic**: When the current player stops, the most recently paused player is resumed
5. **Stack Management**: Maintains a LIFO stack of paused players

## Troubleshooting

### Extension not appearing

- Ensure you've restarted GNOME Shell after installation
- Check that the extension directory name matches the UUID in `metadata.json`
- Verify schemas are compiled: `ls schemas/gschemas.compiled`

### Extension not working

- Check GNOME Shell logs: `journalctl -f -o cat /usr/bin/gnome-shell`
- Ensure your media players support MPRIS (most modern players do)
- Try disabling and re-enabling the extension

## Comparison with Bash Script

This extension replaces the original bash script (`smart-pause-resume`) with:

- ✅ Native GNOME Shell integration
- ✅ No external dependencies (no `playerctl` needed)
- ✅ Direct D-Bus communication
- ✅ Graphical preferences UI
- ✅ Better performance (no subprocess spawning)

The bash script is still available for non-GNOME environments.

## License

MIT
