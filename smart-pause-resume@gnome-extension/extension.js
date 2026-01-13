import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const MPRIS_PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';

export default class SmartPauseResumeExtension extends Extension {
    constructor(metadata) {
        super(metadata);
        this._players = new Map();      // busName → {proxy, signalId}
        this._status = new Map();       // busName → 'Playing'|'Paused'|'Stopped'
        this._autoPaused = new Set();   // Set of busNames we paused
        this._pausedStack = [];         // LIFO: index 0 = top
        this._dbusProxy = null;
        this._nameOwnerChangedId = null;
        this._settings = null;
    }

    enable() {
        this._settings = this.getSettings();

        // Watch for MPRIS players appearing/disappearing on session bus
        this._dbusProxy = Gio.DBusProxy.new_for_bus_sync(
            Gio.BusType.SESSION,
            Gio.DBusProxyFlags.NONE,
            null,
            'org.freedesktop.DBus',
            '/org/freedesktop/DBus',
            'org.freedesktop.DBus',
            null
        );

        this._nameOwnerChangedId = this._dbusProxy.connectSignal(
            'NameOwnerChanged',
            this._onNameOwnerChanged.bind(this)
        );

        // Scan for existing players
        this._scanExistingPlayers();
    }

    disable() {
        // Disconnect signal
        if (this._nameOwnerChangedId && this._dbusProxy) {
            this._dbusProxy.disconnectSignal(this._nameOwnerChangedId);
            this._nameOwnerChangedId = null;
        }

        // Clean up all player proxies
        for (let busName of this._players.keys()) {
            this._removePlayer(busName);
        }

        this._players.clear();
        this._status.clear();
        this._autoPaused.clear();
        this._pausedStack = [];
        this._dbusProxy = null;
        this._settings = null;
    }

    _scanExistingPlayers() {
        try {
            const result = this._dbusProxy.call_sync(
                'ListNames',
                null,
                Gio.DBusCallFlags.NONE,
                -1,
                null
            );

            const [names] = result.deepUnpack();
            let designatedPlayer = null;

            for (let name of names) {
                if (name.startsWith(MPRIS_PREFIX)) {
                    const player = this._addPlayer(name);
                    if (player) {
                        const status = this._getPlayerStatus(player);
                        this._status.set(name, status);

                        if (status === 'Playing') {
                            if (!designatedPlayer) {
                                designatedPlayer = name;
                            } else {
                                // Already have a playing player, pause this one
                                this._pausePlayer(name);
                            }
                        }
                    }
                }
            }
        } catch (e) {
            console.error('Failed to scan existing players', e);
        }
    }

    _onNameOwnerChanged(proxy, sender, [name, oldOwner, newOwner]) {
        if (!name.startsWith(MPRIS_PREFIX))
            return;

        if (newOwner && !oldOwner) {
            // Player appeared
            this._addPlayer(name);
        } else if (!newOwner && oldOwner) {
            // Player disappeared
            this._removePlayer(name);
        }
    }

    _addPlayer(busName) {
        if (this._players.has(busName))
            return this._players.get(busName).proxy;

        try {
            const proxy = Gio.DBusProxy.new_for_bus_sync(
                Gio.BusType.SESSION,
                Gio.DBusProxyFlags.NONE,
                null,
                busName,
                MPRIS_PATH,
                MPRIS_PLAYER_IFACE,
                null
            );

            // Subscribe to PropertiesChanged signal directly on the D-Bus connection
            // This is more reliable than g-properties-changed for some players
            const connection = Gio.bus_get_sync(Gio.BusType.SESSION, null);
            const uniqueName = proxy.get_name_owner() || busName;
            const signalId = connection.signal_subscribe(
                uniqueName,
                'org.freedesktop.DBus.Properties',
                'PropertiesChanged',
                MPRIS_PATH,
                null, // arg0 filter - set to null to receive all
                Gio.DBusSignalFlags.NONE,
                (conn, sender, path, iface, signal, params) => {
                    console.log(`[SmartPauseResume] PropertiesChanged received from ${busName}`);
                    const [interfaceName, changedProps, invalidatedProps] = params.deepUnpack();
                    console.log(`[SmartPauseResume] Interface: ${interfaceName}, Props: ${JSON.stringify(Object.keys(changedProps))}`);
                    if (interfaceName === MPRIS_PLAYER_IFACE && changedProps['PlaybackStatus']) {
                        const status = changedProps['PlaybackStatus'].deepUnpack();
                        console.log(`[SmartPauseResume] Status changed to: ${status}`);
                        this._onStatusChanged(busName, status);
                    }
                }
            );

            this._players.set(busName, { proxy, signalId, connection });

            // Get initial status
            const initialStatus = this._getPlayerStatus(proxy);
            this._status.set(busName, initialStatus);

            // If this player is Playing and extension is enabled, pause others
            if (initialStatus === 'Playing' && this._settings.get_boolean('enabled')) {
                this._pauseOthers(busName);
            }

            return proxy;
        } catch (e) {
            console.error(`Failed to add player ${busName}`, e);
            return null;
        }
    }

    _removePlayer(busName) {
        const playerObj = this._players.get(busName);
        if (playerObj) {
            if (playerObj.signalId && playerObj.connection) {
                playerObj.connection.signal_unsubscribe(playerObj.signalId);
            }
            this._players.delete(busName);
        }

        this._status.delete(busName);
        this._autoPaused.delete(busName);
        this._removeFromStack(busName);

        // If no one is playing, resume next
        if (!this._anyPlaying()) {
            this._resumeNext();
        }
    }

    _getPlayerStatus(player) {
        try {
            const status = player.get_cached_property('PlaybackStatus');
            return status ? status.deepUnpack() : 'Stopped';
        } catch (e) {
            return 'Stopped';
        }
    }

    _onStatusChanged(busName, status) {
        if (!this._settings.get_boolean('enabled'))
            return;

        const oldStatus = this._status.get(busName);
        this._status.set(busName, status);

        if (status === 'Playing') {
            this._autoPaused.delete(busName);
            this._removeFromStack(busName);
            this._pauseOthers(busName);
        } else if (status === 'Paused' || status === 'Stopped') {
            // Check if we auto-paused this player
            if (this._autoPaused.has(busName)) {
                this._autoPaused.delete(busName);
                return; // Ignore, we did it
            }

            // User action - wait a bit to confirm, then resume next
            const delay = this._settings.get_int('resume-delay');
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
                // Double-check status hasn't changed back to Playing
                const playerObj = this._players.get(busName);
                if (playerObj) {
                    const currentStatus = this._getPlayerStatus(playerObj.proxy);
                    if (currentStatus === 'Playing') {
                        return GLib.SOURCE_REMOVE;
                    }
                }

                this._removeFromStack(busName);
                if (!this._anyPlaying()) {
                    this._resumeNext();
                }
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _pausePlayer(busName) {
        const playerObj = this._players.get(busName);
        if (!playerObj)
            return;

        try {
            this._autoPaused.add(busName);
            playerObj.proxy.call_sync('Pause', null, Gio.DBusCallFlags.NONE, -1, null);
            this._status.set(busName, 'Paused');
            this._pushStack(busName);
        } catch (e) {
            // Player might have disappeared
            this._autoPaused.delete(busName);
        }
    }

    _pauseOthers(currentBusName) {
        for (let [busName, player] of this._players) {
            if (busName === currentBusName)
                continue;

            const status = this._status.get(busName);
            if (status === 'Playing') {
                this._pausePlayer(busName);
            }
        }
    }

    _resumeNext() {
        while (this._pausedStack.length > 0) {
            const busName = this._pausedStack.shift();

            // Check if player still exists
            if (!this._status.has(busName))
                continue;

            const playerObj = this._players.get(busName);
            if (!playerObj)
                continue;

            try {
                playerObj.proxy.call_sync('Play', null, Gio.DBusCallFlags.NONE, -1, null);
                this._status.set(busName, 'Playing');
                this._autoPaused.delete(busName);
                return; // Successfully resumed
            } catch (e) {
                // Player vanished, try next
                this._status.delete(busName);
                this._autoPaused.delete(busName);
            }
        }
    }

    _anyPlaying() {
        for (let status of this._status.values()) {
            if (status === 'Playing')
                return true;
        }
        return false;
    }

    _pushStack(busName) {
        // Remove duplicates
        this._pausedStack = this._pausedStack.filter(name => name !== busName);
        // Add to top (index 0)
        this._pausedStack.unshift(busName);
    }

    _removeFromStack(busName) {
        this._pausedStack = this._pausedStack.filter(name => name !== busName);
    }
}
