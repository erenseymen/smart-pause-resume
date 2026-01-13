import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class SmartPauseResumePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        // Create a preferences page
        const page = new Adw.PreferencesPage({
            title: 'General',
            icon_name: 'dialog-information-symbolic',
        });
        window.add(page);

        // Create a preferences group
        const group = new Adw.PreferencesGroup({
            title: 'Behavior',
            description: 'Configure auto-pause and resume behavior',
        });
        page.add(group);

        // Enable/disable toggle
        const enabledRow = new Adw.SwitchRow({
            title: 'Enable Auto-Pause/Resume',
            subtitle: 'Automatically pause other players when one starts playing',
        });
        group.add(enabledRow);

        settings.bind(
            'enabled',
            enabledRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );

        // Resume delay slider
        const delayRow = new Adw.ActionRow({
            title: 'Resume Delay',
            subtitle: 'Time to wait before resuming another player (milliseconds)',
        });
        group.add(delayRow);

        const delaySpinButton = new Gtk.SpinButton({
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 2000,
                step_increment: 100,
            }),
            valign: Gtk.Align.CENTER,
        });
        delayRow.add_suffix(delaySpinButton);
        delayRow.activatable_widget = delaySpinButton;

        settings.bind(
            'resume-delay',
            delaySpinButton,
            'value',
            Gio.SettingsBindFlags.DEFAULT
        );
    }
}
