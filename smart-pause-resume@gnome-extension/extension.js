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
 */
const SmartPauseResumeToggle = GObject.registerClass(
    class SmartPauseResumeToggle extends QuickSettings.QuickToggle {
        constructor(extensionObject) {
            const iconPath = extensionObject.dir.get_child('icons')
                .get_child('smart-pause-resume-symbolic.svg');
            const gicon = Gio.FileIcon.new(iconPath);

            super({
                title: 'Smart Pause',
                subtitle: 'Auto-pause media',
                gicon: gicon,
                toggleMode: true,
            });

            this._settings = extensionObject.getSettings();
            this._settings.bind(
                'enabled',
                this,
                'checked',
                Gio.SettingsBindFlags.DEFAULT
            );
        }

        destroy() {
            this._settings = null;
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

/**
 * Manages the LIFO stack of paused players for smart resume functionality.
 */
class ResumeStack {
    constructor() {
        this._stack = [];
    }

    push(busName) {
        this._stack = this._stack.filter(name => name !== busName);
        this._stack.unshift(busName);
    }

    pop() {
        return this._stack.shift();
    }

    remove(busName) {
        this._stack = this._stack.filter(name => name !== busName);
    }

    isEmpty() {
        return this._stack.length === 0;
    }

    clear() {
        this._stack = [];
    }
}

/**
 * Tracks GLib timeouts and ensures they are cleaned up on destroy.
 */
class TimeoutManager {
    constructor() {
        this._timeouts = new Set();
    }

    add(delay, callback) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._timeouts.delete(id);
            return callback();
        });
        this._timeouts.add(id);
        return id;
    }

    clear() {
        for (const id of this._timeouts) {
            GLib.source_remove(id);
        }
        this._timeouts.clear();
    }
}

/**
 * Manages MPRIS player discovery, proxies, and playback control.
 */
class MprisPlayerManager {
    constructor(callbacks) {
        this._callbacks = callbacks; // { onStatusChanged }
        this._players = new Map();   // busName → {proxy, signalId}
        this._status = new Map();    // busName → 'Playing'|'Paused'|'Stopped'
        this._autoPaused = new Set();
        this._connection = null;
        this._dbusProxy = null;
        this._nameOwnerChangedId = null;
        this._isActive = false;
    }

    /**
     * Initialize DBus connections and start monitoring players.
     */
    initialize() {
        console.log('[Smart Pause Resume] Initializing player manager...');
        this._isActive = true;

        Gio.bus_get(Gio.BusType.SESSION, null, (obj, res) => {
            if (!this._isActive) return;
            try {
                this._connection = Gio.bus_get_finish(res);
                this._subscribeToNameOwnerChanged();
                this._createDbusProxy();
            } catch (e) {
                console.error('[Smart Pause Resume] Failed to get session bus', e);
            }
        });
    }

    _subscribeToNameOwnerChanged() {
        this._nameOwnerChangedId = this._connection.signal_subscribe(
            'org.freedesktop.DBus',
            'org.freedesktop.DBus',
            'NameOwnerChanged',
            '/org/freedesktop/DBus',
            null,
            Gio.DBusSignalFlags.NONE,
            this._onNameOwnerChanged.bind(this)
        );
    }

    _createDbusProxy() {
        Gio.DBusProxy.new_for_bus(
            Gio.BusType.SESSION,
            Gio.DBusProxyFlags.NONE,
            null,
            'org.freedesktop.DBus',
            '/org/freedesktop/DBus',
            'org.freedesktop.DBus',
            null,
            (proxyObj, proxyRes) => {
                if (!this._isActive) return;
                try {
                    this._dbusProxy = Gio.DBusProxy.new_for_bus_finish(proxyRes);
                    this._scanExistingPlayers();
                } catch (e) {
                    console.error('[Smart Pause Resume] Failed to create DBus proxy', e);
                }
            }
        );
    }

    _scanExistingPlayers() {
        if (!this._dbusProxy) return;

        console.log('[Smart Pause Resume] Scanning for players...');
        this._dbusProxy.call(
            'ListNames',
            null,
            Gio.DBusCallFlags.NONE,
            -1,
            null,
            (proxy, res) => {
                if (!this._isActive) return;
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

        Gio.DBusProxy.new_for_bus(
            Gio.BusType.SESSION,
            Gio.DBusProxyFlags.NONE,
            null,
            busName,
            MPRIS_PATH,
            MPRIS_PLAYER_IFACE,
            null,
            (obj, res) => {
                if (!this._isActive) return;
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
        if (!this._isActive || !this._connection) return;

        try {
            const signalId = this._connection.signal_subscribe(
                null,
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
                        this._handleStatusChange(busName, status);
                    }
                }
            );

            this._players.set(busName, { proxy, signalId });
            this._updatePlayerStatus(busName, proxy);
        } catch (e) {
            console.error(`[Smart Pause Resume] Error setting up player ${busName}`, e);
        }
    }

    _updatePlayerStatus(busName, proxy) {
        const status = this._getPlayerStatusCached(proxy);
        if (status && status !== 'Stopped') {
            this._handleStatusChange(busName, status);
            return;
        }

        proxy.call(
            'org.freedesktop.DBus.Properties.Get',
            new GLib.Variant('(ss)', [MPRIS_PLAYER_IFACE, 'PlaybackStatus']),
            Gio.DBusCallFlags.NONE,
            -1,
            null,
            (obj, res) => {
                if (!this._isActive) return;
                try {
                    const result = obj.call_finish(res);
                    const [val] = result.deepUnpack();
                    const status = val.recursiveUnpack();
                    this._handleStatusChange(busName, status);
                } catch (e) {
                    this._status.set(busName, 'Stopped');
                }
            }
        );
    }

    _handleStatusChange(busName, status) {
        const oldStatus = this._status.get(busName);
        this._status.set(busName, status);
        this._callbacks.onStatusChanged(busName, status, oldStatus, this._autoPaused.has(busName));

        if (this._autoPaused.has(busName) && (status === 'Paused' || status === 'Stopped')) {
            this._autoPaused.delete(busName);
        }
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
        this._callbacks.onPlayerRemoved?.(busName);
    }

    _getPlayerStatusCached(proxy) {
        try {
            const val = proxy.get_cached_property('PlaybackStatus');
            return val ? val.deepUnpack() : 'Stopped';
        } catch (e) {
            return 'Stopped';
        }
    }

    /**
     * Get cached status for a player by bus name.
     */
    getStatus(busName) {
        return this._status.get(busName);
    }

    /**
     * Get cached status using proxy.
     */
    getStatusCached(busName) {
        const playerObj = this._players.get(busName);
        if (!playerObj) return 'Stopped';
        return this._getPlayerStatusCached(playerObj.proxy);
    }

    /**
     * Check if any player is currently playing.
     */
    isAnyPlaying() {
        for (let status of this._status.values()) {
            if (status === 'Playing') return true;
        }
        return false;
    }

    /**
     * Check if player exists.
     */
    hasPlayer(busName) {
        return this._players.has(busName);
    }

    /**
     * Pause a specific player.
     */
    pausePlayer(busName, onSuccess) {
        const playerObj = this._players.get(busName);
        if (!playerObj) return;

        this._autoPaused.add(busName);
        playerObj.proxy.call(
            'Pause',
            null,
            Gio.DBusCallFlags.NONE,
            -1,
            null,
            (obj, res) => {
                if (!this._isActive) return;
                try {
                    obj.call_finish(res);
                    this._status.set(busName, 'Paused');
                    onSuccess?.();
                } catch (e) {
                    this._autoPaused.delete(busName);
                }
            }
        );
    }

    /**
     * Pause all players except the specified one.
     */
    pauseOthers(currentBusName, onEachPaused) {
        for (let [busName] of this._players) {
            if (busName === currentBusName) continue;

            const status = this._status.get(busName);
            if (status === 'Playing') {
                this.pausePlayer(busName, () => onEachPaused?.(busName));
            }
        }
    }

    /**
     * Resume a specific player.
     */
    playPlayer(busName, onSuccess, onError) {
        const playerObj = this._players.get(busName);
        if (!playerObj) {
            onError?.();
            return;
        }

        playerObj.proxy.call(
            'Play',
            null,
            Gio.DBusCallFlags.NONE,
            -1,
            null,
            (obj, res) => {
                if (!this._isActive) return;
                try {
                    obj.call_finish(res);
                    this._status.set(busName, 'Playing');
                    this._autoPaused.delete(busName);
                    onSuccess?.();
                } catch (e) {
                    onError?.();
                }
            }
        );
    }

    /**
     * Clean up all resources.
     */
    destroy() {
        console.log('[Smart Pause Resume] Destroying player manager...');
        this._isActive = false;

        if (this._nameOwnerChangedId && this._connection) {
            this._connection.signal_unsubscribe(this._nameOwnerChangedId);
            this._nameOwnerChangedId = null;
        }

        for (let busName of this._players.keys()) {
            const playerObj = this._players.get(busName);
            if (playerObj?.signalId && this._connection) {
                this._connection.signal_unsubscribe(playerObj.signalId);
            }
        }

        this._connection = null;
        this._dbusProxy = null;
        this._players.clear();
        this._status.clear();
        this._autoPaused.clear();
    }
}

/**
 * Main Extension Class
 * 
 * Focused on lifecycle management (enable/disable) and coordinating
 * the player manager with the resume stack.
 */
export default class SmartPauseResumeExtension extends Extension {
    constructor(metadata) {
        super(metadata);
        this._playerManager = null;
        this._resumeStack = null;
        this._timeoutManager = null;
        this._settings = null;
        this._settingsChangedId = null;
        this._toggleVisibilityChangedId = null;
        this._indicator = null;
        this._idleId = 0;
    }

    enable() {
        this._settings = this.getSettings();

        this._syncIndicator();

        this._toggleVisibilityChangedId = this._settings.connect(
            'changed::show-quick-settings-toggle',
            () => this._syncIndicator()
        );

        this._settingsChangedId = this._settings.connect('changed::enabled', () => {
            if (this._settings.get_boolean('enabled')) {
                this._activate();
            } else {
                this._deactivate();
            }
        });

        if (this._settings.get_boolean('enabled')) {
            this._idleId = GLib.idle_add(GLib.PRIORITY_LOW, () => {
                this._idleId = 0;
                this._activate();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    disable() {
        if (this._settingsChangedId && this._settings) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }

        if (this._toggleVisibilityChangedId && this._settings) {
            this._settings.disconnect(this._toggleVisibilityChangedId);
            this._toggleVisibilityChangedId = null;
        }

        this._deactivate();

        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }

        this._settings = null;
    }

    _syncIndicator() {
        const showToggle = this._settings.get_boolean('show-quick-settings-toggle');

        if (showToggle && !this._indicator) {
            this._indicator = new SmartPauseResumeIndicator(this);
            Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
        } else if (!showToggle && this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }

    _activate() {
        console.log('[Smart Pause Resume] Activating...');

        this._resumeStack = new ResumeStack();
        this._timeoutManager = new TimeoutManager();
        this._playerManager = new MprisPlayerManager({
            onStatusChanged: this._onStatusChanged.bind(this),
            onPlayerRemoved: this._onPlayerRemoved.bind(this),
        });

        this._playerManager.initialize();
    }

    _deactivate() {
        console.log('[Smart Pause Resume] Deactivating...');

        if (this._idleId) {
            GLib.source_remove(this._idleId);
            this._idleId = 0;
        }

        this._timeoutManager?.clear();
        this._timeoutManager = null;

        this._playerManager?.destroy();
        this._playerManager = null;

        this._resumeStack?.clear();
        this._resumeStack = null;
    }

    _onStatusChanged(busName, status, oldStatus, wasAutoPaused) {
        if (!this._settings) return;

        if (status === 'Playing') {
            this._resumeStack.remove(busName);
            this._playerManager.pauseOthers(busName, (pausedBusName) => {
                this._resumeStack.push(pausedBusName);
            });
        } else if (status === 'Paused' || status === 'Stopped') {
            if (wasAutoPaused) return;

            const delay = this._settings.get_int('resume-delay');
            this._timeoutManager.add(delay, () => {
                if (this._playerManager?.hasPlayer(busName)) {
                    const currentStatus = this._playerManager.getStatusCached(busName);
                    if (currentStatus === 'Playing') return GLib.SOURCE_REMOVE;
                }

                this._resumeStack.remove(busName);
                this._resumeNext();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _onPlayerRemoved(busName) {
        this._resumeStack?.remove(busName);
        this._resumeNext();
    }

    _resumeNext() {
        if (!this._playerManager || this._playerManager.isAnyPlaying()) return;
        if (!this._resumeStack || this._resumeStack.isEmpty()) return;

        const busName = this._resumeStack.pop();
        if (!busName || !this._playerManager.hasPlayer(busName)) {
            this._resumeNext();
            return;
        }

        this._playerManager.playPlayer(
            busName,
            null,
            () => this._resumeNext()
        );
    }
}
