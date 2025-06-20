# smart-pause-resume

Guarantee that **only one MPRIS player** is "Playing" at a time on your Linux desktop. When you start or resume a media player, all others are auto-paused. When you pause/stop/close the current player, the most recently paused one resumes. Each player window (bus name) is treated independently.

This script is created with ChatGPT o3.

https://chatgpt.com/share/6854a758-aec0-8006-bedf-baf606a9ce59

## Features
- **Auto-pause** all other players when one starts or resumes
- **Resume** the most-recently paused player when the foreground one is paused, stopped, or quits
- **Distinct** handling for every MPRIS bus-name (e.g. `vlc.instance-42`)
- **Stack-based**: If you stop/close a player, it is removed from the stack forever
- **No duplicates** in the paused-player stack (LIFO)

## Requirements
- Bash 4+
- [Playerctl](https://github.com/altdesktop/playerctl) ≥2.2

## Installation
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

## Usage
Just run the script in the background, or use the systemd service. It will listen for MPRIS events and manage playback automatically.

## How it works
- Listens for MPRIS events using `playerctl --all-players --follow status`
- Maintains a stack of paused players
- Only resumes players that were auto-paused by the script
- Ignores players stopped/paused by the user

## License
MIT
