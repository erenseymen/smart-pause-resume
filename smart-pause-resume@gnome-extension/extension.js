import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';

// MPRIS Usage per spec: https://specifications.freedesktop.org/mpris-spec/latest/
const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const MPRIS_PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';

/**
 * Quick Settings Toggle for Smart Pause/Resume
 * 
 * Provides a UI switch in the Quick Settings menu to easily enable/disable 
 * the auto-pause functionality without going to Extensions app.
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

            // Bi-directional binding helps keep UI in sync with GSettings
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
 * 
 * Container to inject the Toggle into the Quick Settings menu.
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

/**
 * Main Extension Class
 * 
 * Logic Overview:
 * 1. Monitors DBus for new/removed Media Players (org.mpris.MediaPlayer2.*).
 * 2. Monitors 'PlaybackStatus' property changes on those players.
 * 3. When a player sends 'Playing', we iterate all other known players and send 'Pause'.
 * 4. We track a LIFO stack of paused players to support 'Smart Resume'.
 * 5. When the active player pauses/stops, we pop from the stack and resume the previous one.
 */
export default class SmartPauseResumeExtension extends Extension {
    constructor(metadata) {
        super(metadata);
        this._players = new Map();      // busName → {proxy, signalId}
        this._status = new Map();       // busName → 'Playing'|'Paused'|'Stopped'
        this._autoPaused = new Set();   // Set of busNames we paused automatically
        this._pausedStack = [];         // LIFO Stack for resume history: index 0 = top (most recent)
        this._dbusProxy = null;
        this._connection = null;
        this._nameOwnerChangedId = null;
        this._settings = null;
        this._idleId = 0;
    }

    /**
     * Extension Lifecycle: Enable
     * 
     * We initialize UI immediately, but defer heavy DBus initialization to an idle handler
     * to avoid blocking the main thread during GNOME Shell startup/extension loading.
     */
    enable() {
        this._settings = this.getSettings();

        // Add Quick Settings toggle
        this._indicator = new SmartPauseResumeIndicator(this);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);

        // Listen for settings changes to activate/deactivate functionality
        this._settingsChangedId = this._settings.connect('changed::enabled', () => {
            if (this._settings.get_boolean('enabled')) {
                this._activate();
            } else {
                this._deactivate();
            }
        });

        // Only initialize if currently enabled
        if (this._settings.get_boolean('enabled')) {
            // Defer initialization to run in the main loop, ensuring non-blocking behavior
            this._idleId = GLib.idle_add(GLib.PRIORITY_LOW, () => {
                this._idleId = 0;
                this._initialize();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    /**
     * Extension Lifecycle: Disable
     * 
     * Thorough cleanup of all signals, proxies, and UI elements.
     */
    disable() {
        // Disconnect settings listener
        if (this._settingsChangedId && this._settings) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }

        // Deactivate functionality
        this._deactivate();

        // Destroy Quick Settings indicator
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }

        this._settings = null;
    }

    /**
     * Activate functionality (called when Quick Settings toggle is turned ON)
     * 
     * Sets up all DBus connections and starts monitoring players.
     */
    _activate() {
        console.log('[Smart Pause Resume] Activating...');
        this._initialize();
    }

    /**
     * Deactivate functionality (called when Quick Settings toggle is turned OFF)
     * 
     * Cleans up all DBus connections, proxies, and state to free resources.
     */
    _deactivate() {
        console.log('[Smart Pause Resume] Deactivating...');

        if (this._idleId) {
            GLib.source_remove(this._idleId);
            this._idleId = 0;
        }

        // Unsubscribe NameOwnerChanged signal
        if (this._nameOwnerChangedId && this._connection) {
            this._connection.signal_unsubscribe(this._nameOwnerChangedId);
            this._nameOwnerChangedId = null;
        }

        // Clean up all player proxies and their signals
        for (let busName of this._players.keys()) {
            this._removePlayer(busName);
        }

        this._connection = null;
        this._dbusProxy = null;
        this._players.clear();
        this._status.clear();
        this._autoPaused.clear();
        this._pausedStack = [];
    }

    /**
     * Async Initialization Chain
     * 
     * 1. Get Session Bus
     * 2. Subscribe to NameOwnerChanged (to detect player start/exit)
     * 3. Create DBus Proxy for org.freedesktop.DBus (to list current names)
     * 4. Scan for existing players
     * 
     * All DBus calls are asynchronous (finish/callback) to prevent UI freezes.
     */
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

    /**
     * Check currently running services and register any that match MPRIS prefix.
     */
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

    /**
     * Handler for DBus NameOwnerChanged
     * Detects when players appear or disappear dynamically.
     */
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

    /**
     * Setup a new player: Create Proxy and subscribe to PropertiesChanged
     */
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
            // Subscribe to PropertiesChanged specifically for this player
            // We use the global connection.signal_subscribe but filter by sender inside the callback
            // This is often more reliable than proxy-signal wrappers for raw property changes.
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
        // 1. Try Cached first to save a roundtrip
        const status = this._getPlayerStatusCached(proxy);
        if (status && status !== 'Stopped') {
            this._onStatusChanged(busName, status);
            return;
        }

        // 2. Fallback to Async Call if cache misses
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

        // If the player that vanished was the one playing, we might want to resume another
        this._resumeNext();
    }

    /**
     * Core Logic: Status Changed
     * Decides whether to pause others or resume previous players.
     */
    _onStatusChanged(busName, status) {
        if (!this._settings) return;

        const oldStatus = this._status.get(busName);
        this._status.set(busName, status);

        if (status === 'Playing') {
            this._autoPaused.delete(busName);
            this._removeFromStack(busName);
            // New player started: Pause others
            this._pauseOthers(busName);
        } else if (status === 'Paused' || status === 'Stopped') {
            // If we automatically paused this player before, ignore this event
            // to avoid loop/confusion.
            if (this._autoPaused.has(busName)) {
                this._autoPaused.delete(busName);
                return;
            }

            // User manually intervened (paused/stopped).
            // Wait a small delay to ensure this isn't a transient state or track change.
            const delay = this._settings.get_int('resume-delay');
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
                // Check if player still exists
                const playerObj = this._players.get(busName);
                if (playerObj) {
                    // Re-check actual status to avoid race conditions
                    const currentStatus = this._getPlayerStatusCached(playerObj.proxy);
                    if (currentStatus === 'Playing') return GLib.SOURCE_REMOVE;
                }

                // If truly stopped/paused, resume the next player in stack
                this._removeFromStack(busName);
                this._resumeNext();
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
        // Don't resume anything if a player is currently playing
        for (let status of this._status.values()) {
            if (status === 'Playing') return;
        }

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

    _pushStack(busName) {
        this._pausedStack = this._pausedStack.filter(name => name !== busName);
        this._pausedStack.unshift(busName);
    }

    _removeFromStack(busName) {
        this._pausedStack = this._pausedStack.filter(name => name !== busName);
    }
}
