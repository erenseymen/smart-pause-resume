import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const MPRIS_PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';

/**
 * Quick Settings Toggle for Smart Pause/Resume
 */
const SmartPauseResumeToggle = GObject.registerClass(
    class SmartPauseResumeToggle extends QuickSettings.QuickToggle {
        constructor(extensionObject) {
            super({
                title: 'Smart Pause',
                subtitle: 'Auto-pause media',
                iconName: 'media-playback-pause-symbolic',
                toggleMode: true,
            });

            this._settings = extensionObject.getSettings();

            // Bind to settings
            this._settings.bind(
                'enabled',
                this,
                'checked',
                Gio.SettingsBindFlags.DEFAULT
            );
        }

        destroy() {
            super.destroy();
        }
    }
);

/**
 * Quick Settings Indicator for Smart Pause/Resume
 */
const SmartPauseResumeIndicator = GObject.registerClass(
    class SmartPauseResumeIndicator extends QuickSettings.SystemIndicator {
        constructor(extensionObject) {
            super();
            this.quickSettingsItems.push(new SmartPauseResumeToggle(extensionObject));
        }

        destroy() {
            this.quickSettingsItems.forEach(item => item.destroy());
            super.destroy();
        }
    }
);

export default class SmartPauseResumeExtension extends Extension {
    constructor(metadata) {
        super(metadata);
        this._players = new Map();      // busName → {proxy, signalId}
        this._status = new Map();       // busName → 'Playing'|'Paused'|'Stopped'
        this._autoPaused = new Set();   // Set of busNames we paused
        this._pausedStack = [];         // LIFO: index 0 = top
        this._dbusProxy = null;
        this._connection = null;
        this._nameOwnerChangedId = null;
        this._settings = null;
        this._idleId = 0;
    }

    enable() {
        this._settings = this.getSettings();

        // Add Quick Settings toggle
        this._indicator = new SmartPauseResumeIndicator(this);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);

        // Defer initialization to run in the main loop, but ensure strictly async DBus usage
        this._idleId = GLib.idle_add(GLib.PRIORITY_LOW, () => {
            this._idleId = 0;
            this._initialize();
            return GLib.SOURCE_REMOVE;
        });
    }

    disable() {
        if (this._idleId) {
            GLib.source_remove(this._idleId);
            this._idleId = 0;
        }

        // Destroy Quick Settings indicator
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }

        // Unsubscribe signals
        if (this._nameOwnerChangedId && this._connection) {
            this._connection.signal_unsubscribe(this._nameOwnerChangedId);
            this._nameOwnerChangedId = null;
        }
        this._connection = null;
        this._dbusProxy = null;

        // Clean up all player proxies
        for (let busName of this._players.keys()) {
            this._removePlayer(busName);
        }

        this._players.clear();
        this._status.clear();
        this._autoPaused.clear();
        this._pausedStack = [];
        this._settings = null;
    }

    _initialize() {
        console.log('[Smart Pause Resume] Initializing asynchronously...');

        // 1. Get Session Connection Asynchronously
        Gio.bus_get(Gio.BusType.SESSION, null, (obj, res) => {
            try {
                this._connection = Gio.bus_get_finish(res);

                // 2. Subscribe to NameOwnerChanged directly
                this._nameOwnerChangedId = this._connection.signal_subscribe(
                    'org.freedesktop.DBus',  // sender
                    'org.freedesktop.DBus',  // interface
                    'NameOwnerChanged',      // signal name
                    '/org/freedesktop/DBus', // object path
                    null,                    // arg0
                    Gio.DBusSignalFlags.NONE,
                    this._onNameOwnerChanged.bind(this)
                );

                // 3. Create Main DBus Proxy Asynchronously (for ListNames)
                Gio.DBusProxy.new_for_bus(
                    Gio.BusType.SESSION,
                    Gio.DBusProxyFlags.NONE,
                    null,
                    'org.freedesktop.DBus',
                    '/org/freedesktop/DBus',
                    'org.freedesktop.DBus',
                    null,
                    (proxyObj, proxyRes) => {
                        try {
                            this._dbusProxy = Gio.DBusProxy.new_for_bus_finish(proxyRes);
                            // 4. Scan existing players once everything is ready
                            this._scanExistingPlayers();
                        } catch (e) {
                            console.error('[Smart Pause Resume] Failed to create DBus proxy', e);
                        }
                    }
                );

            } catch (e) {
                console.error('[Smart Pause Resume] Failed to get session bus', e);
            }
        });
    }

    _scanExistingPlayers() {
        if (!this._dbusProxy) return;

        console.log('[Smart Pause Resume] Scanning for players...');
        // Async call to ListNames
        this._dbusProxy.call(
            'ListNames',
            null,
            Gio.DBusCallFlags.NONE,
            -1,
            null,
            (proxy, res) => {
                if (!this._settings) return;
                try {
                    const result = proxy.call_finish(res);
                    const [names] = result.deepUnpack();

                    for (let name of names) {
                        if (name.startsWith(MPRIS_PREFIX)) {
                            this._addPlayer(name);
                        }
                    }
                } catch (e) {
                    console.error('[Smart Pause Resume] ListNames failed', e);
                }
            }
        );
    }

    _onNameOwnerChanged(connection, sender, path, iface, signalName, parameters) {
        try {
            const [name, oldOwner, newOwner] = parameters.deepUnpack();

            if (!name.startsWith(MPRIS_PREFIX)) return;

            if (newOwner !== oldOwner) {
                if (oldOwner) this._removePlayer(name);
                if (newOwner) this._addPlayer(name);
            }
        } catch (e) {
            console.error('[Smart Pause Resume] Error in NameOwnerChanged', e);
        }
    }

    _addPlayer(busName) {
        if (this._players.has(busName)) return;

        // Async Proxy Creation
        Gio.DBusProxy.new_for_bus(
            Gio.BusType.SESSION,
            Gio.DBusProxyFlags.NONE,
            null,
            busName,
            MPRIS_PATH,
            MPRIS_PLAYER_IFACE,
            null,
            (obj, res) => {
                try {
                    const proxy = Gio.DBusProxy.new_for_bus_finish(res);
                    this._onPlayerProxyReady(busName, proxy);
                } catch (e) {
                    console.error(`[Smart Pause Resume] Failed to create proxy for ${busName}`, e);
                }
            }
        );
    }

    _onPlayerProxyReady(busName, proxy) {
        // Double check if we still need this player (might have been removed while connecting)
        if (!this._connection || !this._settings) return;

        try {
            // Subscribe to PropertiesChanged
            const signalId = this._connection.signal_subscribe(
                null, // sender (listen to all, filter in callback)
                'org.freedesktop.DBus.Properties',
                'PropertiesChanged',
                MPRIS_PATH,
                null,
                Gio.DBusSignalFlags.NONE,
                (conn, sender, path, iface, signal, params) => {
                    const currentOwner = proxy.get_name_owner();
                    if (!currentOwner || sender !== currentOwner) return;

                    const [interfaceName, changedProps] = params.deepUnpack();
                    if (interfaceName === MPRIS_PLAYER_IFACE && changedProps['PlaybackStatus']) {
                        const status = changedProps['PlaybackStatus'].deepUnpack();
                        this._onStatusChanged(busName, status);
                    }
                }
            );

            this._players.set(busName, { proxy, signalId });

            // Check initial status
            this._updatePlayerStatus(busName, proxy);

        } catch (e) {
            console.error(`[Smart Pause Resume] Error setting up player ${busName}`, e);
        }
    }

    _updatePlayerStatus(busName, proxy) {
        // 1. Try Cached
        const status = this._getPlayerStatusCached(proxy);
        if (status && status !== 'Stopped') {
            this._onStatusChanged(busName, status);
            return;
        }

        // 2. Fallback to Async Call
        proxy.call(
            'org.freedesktop.DBus.Properties.Get',
            new GLib.Variant('(ss)', [MPRIS_PLAYER_IFACE, 'PlaybackStatus']),
            Gio.DBusCallFlags.NONE,
            -1,
            null,
            (obj, res) => {
                if (!this._settings) return;
                try {
                    const result = obj.call_finish(res);
                    const [val] = result.deepUnpack();
                    const status = val.recursiveUnpack();
                    this._onStatusChanged(busName, status);
                } catch (e) {
                    // Ignore errors (player might have vanished)
                    this._status.set(busName, 'Stopped');
                }
            }
        );
    }

    _removePlayer(busName) {
        const playerObj = this._players.get(busName);
        if (playerObj) {
            if (playerObj.signalId && this._connection) {
                this._connection.signal_unsubscribe(playerObj.signalId);
            }
            this._players.delete(busName);
        }

        this._status.delete(busName);
        this._autoPaused.delete(busName);
        this._removeFromStack(busName);

        if (!this._anyPlaying()) {
            this._resumeNext();
        }
    }

    _onStatusChanged(busName, status) {
        if (!this._settings || !this._settings.get_boolean('enabled')) return;

        const oldStatus = this._status.get(busName);
        this._status.set(busName, status);

        if (status === 'Playing') {
            this._autoPaused.delete(busName);
            this._removeFromStack(busName);
            // Pause others
            this._pauseOthers(busName);
        } else if (status === 'Paused' || status === 'Stopped') {
            if (this._autoPaused.has(busName)) {
                this._autoPaused.delete(busName);
                return;
            }

            // User initiated pause - wait delay before resuming next
            const delay = this._settings.get_int('resume-delay');
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
                // Check if still exists and status actually currently valid
                const playerObj = this._players.get(busName);
                if (playerObj) {
                    // Re-check status just in case
                    const currentStatus = this._getPlayerStatusCached(playerObj.proxy);
                    if (currentStatus === 'Playing') return GLib.SOURCE_REMOVE;
                }

                this._removeFromStack(busName);
                if (!this._anyPlaying()) {
                    this._resumeNext();
                }
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _getPlayerStatusCached(proxy) {
        try {
            const val = proxy.get_cached_property('PlaybackStatus');
            return val ? val.deepUnpack() : 'Stopped';
        } catch (e) {
            return 'Stopped';
        }
    }

    _pausePlayer(busName) {
        const playerObj = this._players.get(busName);
        if (!playerObj) return;

        this._autoPaused.add(busName);
        // Async Pause
        playerObj.proxy.call(
            'Pause',
            null,
            Gio.DBusCallFlags.NONE,
            -1,
            null,
            (obj, res) => {
                if (!this._settings) return;
                try {
                    obj.call_finish(res);
                    this._status.set(busName, 'Paused');
                    this._pushStack(busName);
                } catch (e) {
                    this._autoPaused.delete(busName);
                }
            }
        );
    }

    _pauseOthers(currentBusName) {
        for (let [busName, playerObj] of this._players) {
            if (busName === currentBusName) continue;

            // We use cached/known status to decide
            const status = this._status.get(busName);
            if (status === 'Playing') {
                this._pausePlayer(busName);
            }
        }
    }

    _resumeNext() {
        while (this._pausedStack.length > 0) {
            const busName = this._pausedStack.shift();
            if (!this._status.has(busName)) continue;

            const playerObj = this._players.get(busName);
            if (!playerObj) continue;

            // Async Play
            playerObj.proxy.call(
                'Play',
                null,
                Gio.DBusCallFlags.NONE,
                -1,
                null,
                (obj, res) => {
                    if (!this._settings) return;
                    try {
                        obj.call_finish(res);
                        this._status.set(busName, 'Playing');
                        this._autoPaused.delete(busName);
                    } catch (e) {
                        // Failed to play, try next one
                        this._resumeNext();
                    }
                }
            );
            return; // We attempted one, stop loop.
        }
    }

    _anyPlaying() {
        for (let status of this._status.values()) {
            if (status === 'Playing') return true;
        }
        return false;
    }

    _pushStack(busName) {
        this._pausedStack = this._pausedStack.filter(name => name !== busName);
        this._pausedStack.unshift(busName);
    }

    _removeFromStack(busName) {
        this._pausedStack = this._pausedStack.filter(name => name !== busName);
    }
}
