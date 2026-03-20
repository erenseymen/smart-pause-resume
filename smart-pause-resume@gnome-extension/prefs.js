import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class SmartPauseResumePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage();
        window.add(page);

        const group = new Adw.PreferencesGroup();
        page.add(group);

        // Show Quick Settings toggle
        const quickSettingsRow = new Adw.SwitchRow({
            title: 'Show Quick Settings Toggle',
            subtitle: 'When enabled, shows the Smart Pause toggle in the Quick Settings panel. When disabled, the toggle is hidden but the extension continues to function.',
        });
        settings.bind(
            'show-quick-settings-toggle',
            quickSettingsRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        group.add(quickSettingsRow);

        // When quick settings toggle is hidden, force enabled to true
        // since the user has no other way to re-enable the extension
        settings.connect('changed::show-quick-settings-toggle', () => {
            if (!settings.get_boolean('show-quick-settings-toggle')) {
                settings.set_boolean('enabled', true);
            }
        });

        // Resume delay
        const delayRow = new Adw.SpinRow({
            title: 'Resume Delay',
            subtitle: 'Time to wait (in milliseconds) before resuming another player. Prevents false triggers when rapidly switching playback states.',
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 2000,
                step_increment: 50,
                page_increment: 200,
                value: settings.get_int('resume-delay'),
            }),
        });
        settings.bind(
            'resume-delay',
            delayRow,
            'value',
            Gio.SettingsBindFlags.DEFAULT
        );
        group.add(delayRow);
    }
}

