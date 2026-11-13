import { App, PluginSettingTab, Setting } from 'obsidian';
import type NoteRelayPlugin from './main';

/**
 * The plugin had no settings pane at all, so Obsidian showed no Options gear and a new user had
 * nothing to click. The status-bar text was the only affordance, and it could not be clicked either.
 *
 * Everything a first-run user needs lives here, in the order they need it: turn hosting on, pair
 * the vault, then open the reader. Each row states what it does and what happens next, because the
 * failure mode this replaces was "hosting is off and I do not know what to do from there".
 */
export class NoteRelaySettingsTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: NoteRelayPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // Credit and version on the first line. A settings page that never says who wrote the plugin is
    // indistinguishable from one that was replaced by something else.
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text: `Note Relay ${this.plugin.manifest.version} by ${this.plugin.manifest.author} — `
        + 'a connector for noterelay.io.',
    });
    containerEl.createEl('p', {
      text: 'This plugin links this vault to your account and lets a browser read it on another '
        + 'device. Your notes stay on this machine — nothing is uploaded, and nothing is reachable '
        + 'until you turn hosting on and link the vault.',
    });

    new Setting(containerEl).setName('This vault').setHeading();

    new Setting(containerEl)
      .setName('Host this vault')
      .setDesc(`Current state: ${this.plugin.hostingStatus()}. `
        + 'Hosting starts a local peer and advertises it; the browser still cannot read anything '
        + 'until the vault is paired.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.hostEnabled)
        .onChange(() => { this.plugin.toggleHosting(); this.display(); }));

    new Setting(containerEl)
      .setName('Account')
      .setDesc(this.plugin.accountLine()
        + ' Connecting shows a short code; you enter it on the website after signing in, then '
        + 'approve this vault there. It links the vault — it does not start hosting.')
      .addButton(button => button
        .setButtonText(this.plugin.accountBinding() ? 'Disconnect' : 'Connect')
        .setCta()
        .onClick(() => {
          if (this.plugin.accountBinding()) {
            void this.plugin.forgetAccount().then(() => { this.display(); });
          } else {
            this.plugin.openConnectModal();
          }
        }));

    new Setting(containerEl)
      .setName('Manage on the site')
      .setDesc('Opens noterelay.io in your default browser, where the vault is read and the account '
        + 'is managed. Sign in with the same account.')
      .addButton(button => button
        .setButtonText('Open site')
        .onClick(() => { window.open(this.plugin.readerOrigin, '_blank'); }));

    new Setting(containerEl).setName('If something goes wrong').setHeading();

    new Setting(containerEl)
      .setName('Pair with a code from the website')
      .setDesc('The other direction: if you already started on the site and it gave you a code, '
        + 'enter it here instead. Same result, same fingerprint check.')
      .addButton(button => button
        .setButtonText('Pair')
        .onClick(() => { this.plugin.openPairing(); }));

    new Setting(containerEl)
      .setName('Replace local pairing key')
      .setDesc('Removes this vault\'s local key and pairs it again. Use it if pairing shows the '
        + 'wrong vault, or if you restored a vault onto a different machine.')
      .addButton(button => button
        .setButtonText('Replace key')
        .setWarning()
        .onClick(() => { this.plugin.openReplacePairingKey(); }));

    new Setting(containerEl)
      .setName('Copy diagnostics for support')
      .setDesc('Copies plugin and Obsidian versions, hosting state, transport, and note count. '
        + 'It never includes note titles, paths, or contents.')
      .addButton(button => button
        .setButtonText('Copy')
        .onClick(async () => { await this.plugin.copyDiagnosticsToClipboard(); }));

    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text: 'The status bar shows the same state as this page; clicking it turns hosting on and off. '
        + 'The ribbon power icon and the command palette do the same thing.',
    });
  }
}
