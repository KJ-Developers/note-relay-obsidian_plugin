import { Modal, Notice, Platform, Plugin, requestUrl, Setting, TFile } from 'obsidian';
import { NoteRelaySettingsTab } from './settings-tab';
import { ObsidianAdapter } from './obsidian-adapter';
import { buildDiagnostics } from './diagnostics';
import { SITE_ORIGIN, WORKER_ORIGIN } from './endpoints';
import { isNewerVersion } from './update-check';
import { makeMermaidRenderer } from './mermaid';
import { HostLifecycle } from './host-lifecycle';
import { dispatchReadOnly, PROTOCOL_VERSION, sha256Hex, validMarkdownPath, type Reply } from './protocol';
import { PairingFlow } from './pairing-flow';
import { getOrCreateDeviceId } from './device-identity';
import { pairingApi } from './pairing-api';
import { deviceApi } from './device-api';
import { DeviceGrantFlow } from './device-grant-client';
import { accountStatusLine, parseBinding, vaultLabel, type AccountBinding } from './account-binding';
import { getExistingHostKey, replaceHostKey } from './pairing-key-store';
import { hostPairingKeyId } from './pairing-key';
import { HostPresenceClient } from './host-presence';
import { HostSignalClient } from './host-signal-client';
import { READER_WAIT_MESSAGE, READER_WAIT_STATUS, ReaderWaitMonitor } from './host-waiting';
import type { AuthorizationLease } from './authenticated-read-session';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * An event listener is typed to return nothing; an async handler returns a promise whose rejection
 * would otherwise be unhandled. This keeps the handler's own try/catch as the single place a failure
 * is reported, and satisfies the listener contract without pretending the work is synchronous.
 */
const fireAndForget = (handler: () => Promise<void>): (() => void) => () => { void handler(); };

class PairingModal extends Modal {
  private get flow(): PairingFlow { return this.plugin.pairingFlow(); }

  constructor(app: Plugin['app'], private plugin: NoteRelayPlugin) { super(app); }

  onOpen(): void {
    this.titleEl.setText('Pair this vault with Note Relay');
    this.contentEl.empty();
    this.contentEl.createEl('p', { text: 'Open the pairing page in a browser where you are signed in, choose Create pairing code, and type that code here. Pairing on its own does not let anyone read the vault — hosting is a separate switch you turn on yourself.' });
    const code = this.contentEl.createEl('input', {
      attr: { type: 'text', maxlength: '11', autocomplete: 'off',
        autocapitalize: 'characters', spellcheck: 'false', placeholder: 'ABCDE-FGHIJ' },
    });
    const status = this.contentEl.createEl('p');
    const reviewButton = this.contentEl.createEl('button', { text: 'Review pairing' });
    reviewButton.addEventListener('click', fireAndForget(async () => {
      reviewButton.disabled = true;
      status.setText('Checking pairing code…');
      try {
        const review = await this.plugin.pairWithCode(code.value);
        this.contentEl.empty();
        this.contentEl.createEl('p', { text: `Account: ${review.accountEmail}` });
        this.contentEl.createEl('p', { text: `Vault: ${review.vaultLabel}` });
        this.contentEl.createEl('p', { text: `Host fingerprint: ${review.hostKeyId}` });
        this.contentEl.createEl('p', { text: 'Check that the same fingerprint appears in your signed-in browser and approve it there. Then confirm here before the code expires.' });
        const result = this.contentEl.createEl('p');
        result.setText('Approve the fingerprint in the browser, then confirm here.');
        const confirmButton = this.contentEl.createEl('button', { text: 'Confirm in Obsidian' });
        confirmButton.addEventListener('click', fireAndForget(async () => {
          confirmButton.disabled = true;
          result.setText('Confirming pairing…');
          try {
            const confirmed = await this.plugin.confirmPairing();
            result.setText(confirmed ? 'Pairing confirmed. Turn the host on from the status bar when you want a browser to be able to reach this vault.' :
              'Not confirmed. Approve the fingerprint in the browser first; if it is already ' +
              'approved, this vault may already be paired — disconnect it there, then start again.');
            if (!confirmed) confirmButton.disabled = false;
          } catch {
            result.setText('Pairing unavailable or expired. Start with a new code.');
          }
        }));
      } catch {
        status.setText('Pairing code unavailable. Check the code or try again later.');
        reviewButton.disabled = false;
      }
    }));
  }

  onClose(): void {
    this.flow.cancel();
    this.plugin.clearPairingModal(this);
  }
}

class ReplacePairingKeyModal extends Modal {
  private closed = false;
  constructor(app: Plugin['app'], private plugin: NoteRelayPlugin) { super(app); }

  onOpen(): void {
    this.titleEl.setText('Replace Note Relay pairing key');
    this.contentEl.empty();
    this.contentEl.createEl('p', { text: 'First disconnect this vault in your signed-in Note Relay browser. Replacing the local key alone does not revoke a cloud host.' });
    const status = this.contentEl.createEl('p', { text: 'Checking local key…' });
    void this.load(status);
  }

  private async load(status: HTMLElement): Promise<void> {
    try {
      if (this.plugin.hostEnabled) throw new Error('Turn off local hosting first.');
      const vaultId = await this.plugin.pairingVaultId();
      const key = await getExistingHostKey(vaultId);
      if (this.closed) return;
      if (!key) { status.setText('No local pairing key exists yet.'); return; }
      const oldId = await hostPairingKeyId(key.publicJwk);
      if (this.closed) return;
      status.setText(`Current fingerprint: ${oldId}`);
      const label = this.contentEl.createEl('label', { text: 'Type REPLACE to confirm' });
      const input = label.createEl('input', {
        attr: { type: 'text', autocomplete: 'off', spellcheck: 'false' },
      });
      const result = this.contentEl.createEl('p');
      const button = this.contentEl.createEl('button', { text: 'Replace local key' });
      button.disabled = true;
      input.addEventListener('input', () => { button.disabled = input.value !== 'REPLACE'; });
      button.addEventListener('click', fireAndForget(async () => {
        if (input.value !== 'REPLACE') return;
        button.disabled = true;
        result.setText('Replacing local key…');
        try {
          const replacement = await replaceHostKey(vaultId, oldId);
          if (this.closed) return;
          result.setText(`New fingerprint: ${await hostPairingKeyId(replacement.publicJwk)}. Pair again with a new code in the browser.`);
          input.disabled = true;
        } catch {
          if (this.closed) return;
          result.setText('Key replacement failed. The current key was not changed.');
          button.disabled = false;
        }
      }));
    } catch (error) {
      if (!this.closed) status.setText(error instanceof Error ? error.message : 'Local key unavailable.');
    }
  }

  onClose(): void { this.closed = true; }
}

class LocalPeerModal extends Modal {
  private sequence = 0;

  constructor(app: Plugin['app'], private plugin: NoteRelayPlugin) { super(app); }

  private async request(cmd: string, path?: string): Promise<Reply> {
    return dispatchReadOnly(this.plugin.adapter, this.plugin.host.currentRequest(), {
      version: PROTOCOL_VERSION, id: `local-${++this.sequence}`, cmd, ...(path ? { path } : {}),
    });
  }

  async onOpen(): Promise<void> {
    this.titleEl.setText('Note Relay same-machine read test');
    this.contentEl.empty();
    if (!this.plugin.hostEnabled) {
      this.contentEl.createEl('p', { text: 'Hosting is off. Enable it from the Note Relay ribbon control.' });
      return;
    }
    const list = await this.request('LIST_VAULT_TREE');
    if (!list.ok) {
      this.contentEl.createEl('p', { text: `List failed: ${list.error}` });
      return;
    }
    const { files: paths, folders } = list.data as { files: string[]; folders: string[] };
    this.contentEl.createEl('p', { text: `${paths.length} Markdown note(s), ${folders.length} folder(s). This test stays inside Obsidian.` });
    const appearance = await this.request('GET_APPEARANCE');
    if (appearance.ok) {
      const data = appearance.data as { mode: string; tokens: Record<string, string> };
      this.contentEl.createEl('p', { text: `Appearance: ${data.mode} · ${Object.keys(data.tokens).length} validated tokens` });
    } else {
      this.contentEl.createEl('p', { text: `Appearance unavailable: ${appearance.error}` });
    }
    const select = this.contentEl.createEl('select');
    for (const path of paths) select.createEl('option', { text: path, value: path });
    if (folders.length > 0) this.contentEl.createEl('p', { text: `Folders: ${folders.join(', ')}` });
    const rasterInput = this.contentEl.createEl('input', { attr: { type: 'text', placeholder: 'Raster asset path in test vault' } });
    const rasterStatus = this.contentEl.createEl('p');
    this.contentEl.createEl('button', { text: 'Test raster read' }).addEventListener('click', fireAndForget(async () => {
      const result = await this.request('READ_RASTER', rasterInput.value);
      if (!result.ok) { rasterStatus.setText(`Raster read: ${result.error}`); return; }
      const data = result.data as { mime: string; base64: string };
      rasterStatus.setText(`Raster read: ${data.mime} · ${Math.floor(data.base64.length * 3 / 4)} encoded bytes`);
    }));
    const status = this.contentEl.createEl('p');
    const preview = this.contentEl.createDiv({ cls: 'markdown-preview-view noterelay-local-preview' });
    const load = async () => {
      const path = select.value;
      if (!path) return;
      const raw = await this.request('READ_MARKDOWN', path);
      const rendered = await this.request('RENDER_PREVIEW', path);
      if (!raw.ok || !rendered.ok) {
        status.setText(`Read failed: ${!raw.ok ? raw.error : !rendered.ok ? rendered.error : 'unknown'}`);
        preview.empty();
        return;
      }
      const data = rendered.data as { html: string; state: string; renderer: string };
      status.setText(`${path} · ${data.state} · ${data.renderer} · ${(raw.data as { source: string }).source.length} source characters`);
      // Parsed by the DOMParser-free range API rather than assigned to innerHTML: RENDER_PREVIEW
      // returns preview.ts output (markdown-it, then DOMPurify with an explicit allow-list), and
      // inserting it as nodes keeps the sanitiser as the only thing that ever built markup.
      const range = activeDocument.createRange();
      range.selectNodeContents(preview);
      // eslint-disable-next-line no-unsanitized/method -- RENDER_PREVIEW returns preview.ts output, already DOMPurify-sanitised against an explicit allow-list
      preview.appendChild(range.createContextualFragment(data.html));
    };
    select.addEventListener('change', () => { void load(); });
    await load();
  }
}

/**
 * Shows the code and waits for the owner to approve it in a browser.
 *
 * The modal is the whole plugin-first onboarding: it names the site, prints a code a person can read
 * across the room, and reports the one thing that matters afterwards — approved, or the code lapsed.
 */
class ConnectVaultModal extends Modal {
  constructor(app: Plugin['app'], private plugin: NoteRelayPlugin) { super(app); }

  /**
   * Built from the same Setting rows as the settings pane.
   *
   * The first version hand-rolled its own headline, oversized code and inline styles, so it read as a
   * different product from the pane behind it. Obsidian's own rows are the design: a name, a muted
   * explanation, and a button on the right.
   */
  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: 'Connect this vault' });

    const intro = contentEl.createEl('p', { cls: 'setting-item-description',
      text: 'Open the link page, sign in or create an account, then approve this vault. '
        + 'The code is already in that link.' });

    const statusEl = contentEl.createEl('p', { cls: 'setting-item-description',
      text: 'Starting…' });

    void (async () => {
      let started: Awaited<ReturnType<NoteRelayPlugin['beginAccountConnection']>>;
      try {
        started = await this.plugin.beginAccountConnection();
      } catch (error) {
        // The reason is the useful part: a 429 says how long to wait, a 404 says the vault may already
        // be linked. Hiding it behind "could not start" is what made this look like a product fault.
        const message = error instanceof Error ? error.message : String(error);
        intro.setText(message);
        statusEl.setText('');
        return;
      }

      contentEl.empty();
      contentEl.createEl('h2', { text: 'Connect this vault' });
      contentEl.createEl('p', { cls: 'setting-item-description',
        text: 'Open the link page, sign in or create an account, then approve this vault. '
          + 'The code is already in that link — you should not have to type it.' });

      const link = `${started.verificationUrl}?code=${encodeURIComponent(started.userCode)}`;

      new Setting(contentEl)
        .setName('Link page')
        .setDesc(started.verificationUrl)
        .addButton(button => button.setButtonText('Open link page').setCta()
          .onClick(() => { window.open(link, '_blank'); }));

      const codeSetting = new Setting(contentEl)
        .setName('Code')
        .setDesc('It is also in the link above.')
        .addButton(button => button.setButtonText('Copy code').onClick(async () => {
          try {
            await navigator.clipboard.writeText(started.userCode);
            button.setButtonText('Copied');
          } catch {
            // Clipboard permission can be refused; say so rather than claim it copied.
            button.setButtonText('Select it above');
          }
        }));
      codeSetting.controlEl.createDiv({ text: started.userCode, cls: 'note-relay-code' });

      const status = contentEl.createEl('p', { cls: 'setting-item-description',
        text: 'Waiting for approval — this window closes by itself.' });

      const result = await this.plugin.awaitAccountConnection(started);
      if (result === 'approved') {
        status.setText('Linked. You can close this window.');
        window.setTimeout(() => this.close(), 1_500);
      } else if (result === 'expired') {
        status.setText('That code expired. Close this and press Connect for a fresh one.');
      } else if (result === 'spent') {
        status.setText('That code was already used. Close this and press Connect again.');
      }
    })();
  }
}

export default class NoteRelayPlugin extends Plugin {
  readonly host = new HostLifecycle();
  adapter!: ObsidianAdapter;
  private statusEl: HTMLElement | null = null;
  private vaultIdPromise: Promise<string> | null = null;
  private pairingModal: PairingModal | null = null;
  private pairingFlowInstance: PairingFlow | null = null;
  private presence: HostPresenceClient | null = null;
  private signal: HostSignalClient | null = null;
  private remoteStatus: 'unpaired' | 'unavailable' | null = null;
  /** True only while the signal client can prove an authenticated reader is attached and stuck. */
  private readerWaiting = false;
  /** The account this vault is linked to, or null. Loaded once in onload and shown in the pane. */
  private binding: AccountBinding | null = null;
  /** A grant that has not lapsed yet, so reopening the dialog does not spend another attempt. */
  private pendingGrant: (Awaited<ReturnType<DeviceGrantFlow['begin']>> & { vaultId: string }) | null = null;

  async onload(): Promise<void> {
    this.adapter = new ObsidianAdapter(this.app);
    // Obsidian ships Mermaid; use it rather than bundling ~5 MB into main.js.
    this.adapter.useMermaid(makeMermaidRenderer());
    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass('note-relay-status');
    // The status bar was the only on-screen affordance and it did nothing when clicked — the
    // instructions said "turn the host on" without saying where. Make it the control it looks like.
    this.statusEl.setAttribute('aria-label', 'Note Relay: click to turn local hosting on or off');
    this.statusEl.onclick = () => this.toggleHost();
    this.setStatus();
    this.watchVaultNotes();
    // One check a day is enough for a manual-install plugin; the notice is dismissible and never nagging.
    void this.checkForUpdate();
    this.registerInterval(window.setInterval(() => void this.checkForUpdate(), 6 * 60 * 60 * 1000));
    this.registerInterval(window.setInterval(() => this.setStatus(), 5_000));
    void this.loadData().then(saved => {
      this.binding = parseBinding((saved as { account?: unknown } | null)?.account);
    });
    this.addSettingTab(new NoteRelaySettingsTab(this.app, this));
    this.addRibbonIcon('power', 'Toggle Note Relay local hosting', () => this.toggleHost());
    this.addCommand({ id: 'toggle-local-host', name: 'Turn vault host on or off', callback: () => this.toggleHost() });
    this.addCommand({ id: 'open-local-peer', name: 'Open same-machine read test', callback: () => new LocalPeerModal(this.app, this).open() });
    this.addCommand({ id: 'pair-vault', name: 'Pair this vault', callback: () => this.openPairing() });
    this.addCommand({ id: 'replace-pairing-key', name: 'Replace local pairing key', callback: () => this.openReplacePairingKey() });
    this.addCommand({ id: 'open-settings', name: 'Open settings pane', callback: () => {
      // Opens the pane this plugin now owns, so the palette can reach it too.
      const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
      setting?.open();
      setting?.openTabById(this.manifest.id);
    } });
    /**
     * Copy a diagnostic bundle for a support email.
     *
     * A ticket that says "it doesn't work" costs an hour of questions; one that says "close 1008
     * vault-busy, plugin 0.1.0, direct, 1k–10k notes" costs five minutes. Everything in it is a fact
     * the user cannot see for themselves, and none of it is about their notes.
     */
    this.addCommand({ id: 'copy-diagnostics', name: 'Copy diagnostics for support', callback: () => {
      void this.copyDiagnostics();
    } });
  }

  /**
   * Builds and copies the diagnostics bundle, then says what was copied.
   *
   * The notice names the two facts a privacy-conscious user actually wants confirmed: that the text
   * is on the clipboard, and that it contains nothing about their notes.
   */
  private async copyDiagnostics(): Promise<void> {
    // Counted here rather than through the adapter: the bundle only needs the bucket, and asking the
    // vault directly avoids widening the adapter interface for a support convenience.
    let notes: number | undefined;
    try { notes = this.app.vault.getMarkdownFiles().length; } catch { notes = undefined; }
    const close = this.signal?.lastCloseRecord() ?? null;
    const text = buildDiagnostics({
      nowMs: Date.now(),
      pluginVersion: this.manifest.version,
      protocolVersion: PROTOCOL_VERSION,
      // Obsidian's version is read from what the app exposes; if it exposes nothing, the line reads
      // `unknown` rather than carrying a guess.
      obsidianVersion: (this.app as unknown as { version?: string }).version,
      platform: Platform.isMacOS ? 'macos' : Platform.isWin ? 'windows'
        : Platform.isLinux ? 'linux' : Platform.isMobile ? 'mobile' : 'desktop',
      hosting: this.hostEnabled,
      presence: this.remoteStatus === 'unpaired' ? 'unpaired'
        : this.hostEnabled ? (this.remoteStatus === 'unavailable' ? 'unavailable' : 'active') : 'idle',
      lastClose: close,
      // The plugin does not track whether the peer is direct or relayed, and a bundle that guessed
      // would be worse than one that says so.
      transport: null,
      noteCount: notes,
      view: 'obsidian',
      endpoint: WORKER_ORIGIN,
    });
    try {
      await navigator.clipboard.writeText(text);
      new Notice('Diagnostics copied. It holds versions and connection state — no note contents.');
    } catch {
      new Notice('Could not copy diagnostics. Clipboard access was refused.');
    }
  }

  /**
   * The single pairing flow instance for this vault.
   *
   * The modal and the headless callers below share it deliberately: a test that drives
   * `pairWithCode` and `confirmPairing` exercises the same review state, the same key and the same
   * signed proof a user's two button presses would, so proving the headless path proves the UI path.
   */
  pairingFlow(): PairingFlow {
    this.pairingFlowInstance ??= new PairingFlow(pairingApi);
    return this.pairingFlowInstance;
  }

  /** Review stage: validates the code, signs the host proof, presents this vault. */
  async pairWithCode(code: string): Promise<{ accountEmail: string; hostKeyId: string;
    pairingId: string; vaultLabel: string; vaultId: string }> {
    const vaultId = await this.pairingVaultId();
    // Sent so the site can retire this machine's previous row for the same vault name after a
    // reinstall, instead of listing the vault twice for the rest of the beta. Absent on a host that
    // refuses app-level storage, which is exactly what an older build sends.
    const device = getOrCreateDeviceId(this.app);
    const review = await this.pairingFlow().review(code.trim().toUpperCase(),
      vaultId, this.app.vault.getName(), device);
    return { accountEmail: review.accountEmail, hostKeyId: review.hostKeyId,
      pairingId: review.pairingId, vaultLabel: review.vaultLabel, vaultId };
  }

  /** Confirm stage: signs the confirmation. Succeeds only after the owner approves in the browser. */
  async confirmPairing(): Promise<boolean> {
    return this.pairingFlow().confirm();
  }

  clearPairingModal(modal: PairingModal): void {
    if (this.pairingModal === modal) this.pairingModal = null;
  }

  async pairingVaultId(): Promise<string> {
    this.vaultIdPromise ??= this.loadPairingVaultId();
    return this.vaultIdPromise;
  }

  private async loadPairingVaultId(): Promise<string> {
    const saved = await this.loadData() as unknown;
    if (saved && typeof saved === 'object' &&
        typeof (saved as { vaultId?: unknown }).vaultId === 'string' &&
        uuid.test((saved as { vaultId: string }).vaultId)) {
      return (saved as { vaultId: string }).vaultId;
    }
    if (saved !== null && saved !== undefined) throw new Error('Invalid Note Relay vault identity');
    const vaultId = crypto.randomUUID();
    await this.saveData({ vaultId });
    return vaultId;
  }

  get hostEnabled(): boolean { return this.host.enabled; }
  currentRemoteLease(): AuthorizationLease | null { return this.presence?.lease() ?? null; }

  /**
   * Public surface for the settings pane and the command palette.
   *
   * These existed only as private internals reached through inline command callbacks, so the pane
   * that tells a new user what to do had no way to call them.
   */
  toggleHosting(): void { this.toggleHost(); }

  hostingStatus(): string { return this.statusText(); }

  /**
   * Tells the owner when a newer plugin exists.
   *
   * Installing stays manual until the community store takes over, and a manual update nobody knows
   * about is how a vault runs a year-old build. This only asks a static file for the current version
   * and puts one notice up, at most once a day, with the download link — it never installs anything.
   */
  private updateNotified = '';
  private async checkForUpdate(): Promise<void> {
    try {
      const response = await requestUrl({ url: `${SITE_ORIGIN}/download/plugin-version.json`,
        method: 'GET', throw: false });
      if (response.status !== 200) return;
      const info = JSON.parse(response.text) as { version?: unknown; url?: unknown };
      const latest = typeof info.version === 'string' ? info.version : '';
      if (!latest || latest === this.manifest.version) return;
      if (!isNewerVersion(latest, this.manifest.version)) return;
      const today = new Date().toISOString().slice(0, 10);
      if (this.updateNotified === `${latest}@${today}`) return;
      this.updateNotified = `${latest}@${today}`;
      const notice = new Notice(
        `Note Relay ${latest} is available (you have ${this.manifest.version}). ` +
        `Download it from noterelay.io/getting-started.`, 15000);
      void notice;
    } catch { /* offline or a broken file is not worth a notice */ }
  }

  /**
   * Watches the vault for changes the plugin can see and tells a reader that is showing that note.
   *
   * Debounced per path, and only sends when the hash actually differs from the last one sent: Obsidian
   * fires `modify` repeatedly while a file is written, and a reader watching the owner type should not
   * receive a stream of notices for one save.
   */
  private noteWatch = new Map<string, { timer: number; lastHash: string }>();
  private watchVaultNotes(): void {
    this.registerEvent(this.app.vault.on('modify', file => {
      if (!this.signal || !this.hostEnabled) return;
      const path = file.path;
      if (!validMarkdownPath(path) || !this.signal.isViewing(path)) return;
      const entry = this.noteWatch.get(path) ?? { timer: 0, lastHash: '' };
      window.clearTimeout(entry.timer);
      entry.timer = window.setTimeout(() => {
        void (async () => {
          try {
            if (!(file instanceof TFile)) return;
            const source = await this.app.vault.cachedRead(file);
            const hash = await sha256Hex(source);
            if (hash === entry.lastHash) return;
            entry.lastHash = hash;
            this.signal?.notifyNoteChanged(path, hash);
          } catch { /* the vault moved under us; the next change will tell the story */ }
        })();
      }, 1500);
      this.noteWatch.set(path, entry);
    }));
  }

  /**
   * Host-side event tail, for a reader that says "connected" and sees nothing.
   *
   * Commands and lifecycle only — never note text, paths or keys.
   */
  debugTail(count = 80): string[] { return this.signal?.debugTail(count) ?? []; }

  get readerOrigin(): string { return WORKER_ORIGIN; }

  openPairing(): void {
    this.pairingModal?.close();
    this.pairingModal = new PairingModal(this.app, this);
    this.pairingModal.open();
  }

  openReplacePairingKey(): void {
    this.pairingModal?.close();
    new ReplacePairingKeyModal(this.app, this).open();
  }

  async copyDiagnosticsToClipboard(): Promise<void> { await this.copyDiagnostics(); }

  /** Plugin data is one object; every writer must merge rather than replace it. */
  private async savePluginData(patch: Record<string, unknown>): Promise<void> {
    const current = (await this.loadData() as Record<string, unknown> | null) ?? {};
    await this.saveData({ ...current, ...patch });
  }

  accountBinding(): AccountBinding | null { return this.binding; }

  openConnectModal(): void { new ConnectVaultModal(this.app, this).open(); }

  accountLine(): string { return accountStatusLine(this.binding); }

  /**
   * Connects this vault to an account, the plugin-first way round.
   *
   * Resolves with what to show the user; the caller (a modal) displays the code and awaits waitFor.
   * Nothing is written to disk until the owner approves in the browser, so an abandoned attempt
   * leaves the vault as it was.
   */
  /**
   * Start (or resume) a device grant.
   *
   * A live grant is reused rather than replaced. The Worker budgets twenty grants per ten minutes for
   * a whole network, and reopening the dialog to read the code again spent one each time — which is how
   * the owner rate limited himself and got a message that did not say so.
   */
  async beginAccountConnection(): Promise<Awaited<ReturnType<DeviceGrantFlow['begin']>>> {
    if (this.binding) throw new Error('This vault is already connected to an account');
    const vaultId = await this.pairingVaultId();

    const pending = this.pendingGrant;
    if (pending && pending.vaultId === vaultId &&
        pending.expiresAtMs - Date.now() > 60_000) return pending;

    const flow = new DeviceGrantFlow(deviceApi);
    const started = await flow.begin({ vaultId, displayLabel: vaultLabel(this.app.vault.getName()) });
    this.pendingGrant = { ...started, vaultId };
    await this.savePluginData({ pendingGrant: this.pendingGrant });
    return started;
  }

  /** Polls until the owner approves, then stores the binding. */
  async awaitAccountConnection(
    started: Awaited<ReturnType<DeviceGrantFlow['begin']>>,
  ): Promise<'approved' | 'expired' | 'spent' | 'pending'> {
    const flow = new DeviceGrantFlow(deviceApi);
    const answer = await flow.wait(started);
    if (answer.state !== 'pending') {
      this.pendingGrant = null;
      await this.savePluginData({ pendingGrant: null });
    }
    if (answer.state === 'approved') {
      this.binding = parseBinding({
        accountId: answer.accountId, email: answer.email,
        hostKeyId: answer.hostKeyId, pairedAt: new Date().toISOString(),
      });
      if (!this.binding) throw new Error('The account response was not usable');
      await this.savePluginData({ account: this.binding });
      new Notice(`Note Relay connected to ${this.binding.email}`);
      // Presence was refused while the vault had no binding; retry it now rather than making the
      // owner toggle hosting to get the reader in.
      await this.refreshRemotePresence();
    }
    return answer.state;
  }

  /**
   * Forgets the local link. The site still lists the vault until it is revoked there, which is
   * deliberate: clearing it silently would leave a live host record the owner believes is gone.
   */
  async forgetAccount(): Promise<void> {
    this.binding = null;
    await this.savePluginData({ account: null });
    new Notice('Note Relay disconnected from this account on this machine. Revoke the vault on the site to remove it there too.');
  }

  onunload(): void {
    this.pairingModal?.close();
    const presence = this.presence;
    this.presence = null;
    this.signal?.stop(); this.signal = null;
    this.host.stop();
    this.remoteStatus = null;
    this.readerWaiting = false;
    if (presence) void presence.stop();
    this.setStatus();
  }

  /**
   * Re-announce after the vault gains a binding.
   *
   * Measured 2026-11-06 on a fresh account: hosting was on, the vault was linked, and the editor still
   * waited forever — because presence had been refused while the vault had no host row, and nothing
   * retried afterwards. The owner's workaround was to toggle hosting off and on.
   */
  private async refreshRemotePresence(): Promise<void> {
    if (!this.hostEnabled) return;
    const presence = this.presence;
    this.presence = null;
    this.signal?.stop(); this.signal = null;
    this.remoteStatus = null;
    if (presence) await presence.stop();
    this.setStatus();
    await this.startRemotePresence();
  }

  private toggleHost(): void {
    if (this.host.enabled) {
      const presence = this.presence;
      this.presence = null;
      this.signal?.stop(); this.signal = null;
      this.host.stop();
      this.remoteStatus = null;
      this.readerWaiting = false;
      if (presence) void presence.stop();
    } else {
      this.host.start();
      this.remoteStatus = null;
      void this.startRemotePresence();
    }
    this.setStatus();
    new Notice(this.hostEnabled ? 'Note Relay read host on; remote presence is verified separately' : 'Note Relay read host off');
  }

  private async startRemotePresence(): Promise<void> {
    const sessionId = this.host.sessionId;
    if (!sessionId) return;
    try {
      const vaultId = await this.pairingVaultId();
      const key = await getExistingHostKey(vaultId);
      if (this.host.sessionId !== sessionId) return;
      if (!key) { this.remoteStatus = 'unpaired'; this.setStatus(); return; }
      const presence = new HostPresenceClient(vaultId, sessionId, key,
        undefined, undefined,
        reason => { if (this.host.sessionId === sessionId) {
          this.remoteStatus = 'unavailable'; this.setStatus(); new Notice(reason);
        } },
        () => {
          if (this.host.sessionId !== sessionId || this.signal) return;
          this.remoteStatus = null; this.setStatus();
          this.signal = new HostSignalClient(vaultId, sessionId, key,
            this.host, this.adapter, () => this.currentRemoteLease(),
            new ReaderWaitMonitor({
              onChange: waiting => this.setReaderWaiting(sessionId, waiting),
            }));
          this.signal.start();
        });
      this.presence = presence;
      presence.start();
    } catch { if (this.host.sessionId === sessionId) {
      this.remoteStatus = 'unavailable'; this.setStatus();
    } }
  }

  /**
   * Shows, then clears, the one state the host can prove: a reader is attached to the room and has
   * not finished its handshake. The Notice is deliberately short-lived — Obsidian's default
   * duration — because the status bar keeps the state until it changes.
   */
  private setReaderWaiting(sessionId: string, waiting: boolean): void {
    // A signal client from an older host generation must not paint the status bar.
    if (this.host.sessionId !== sessionId || this.readerWaiting === waiting) return;
    this.readerWaiting = waiting;
    this.setStatus();
    if (waiting) new Notice(READER_WAIT_MESSAGE);
  }

  private statusText(): string {
    return !this.hostEnabled ? 'off' : this.readerWaiting ? READER_WAIT_STATUS
      : this.currentRemoteLease() ? 'remote presence active' : this.remoteStatus === 'unpaired'
        ? 'hosting on; vault not paired' : this.remoteStatus === 'unavailable'
          ? 'hosting on; remote unavailable' : 'hosting on; remote lease pending';
  }

  private setStatus(): void {
    this.statusEl?.setText(`Note Relay: ${this.statusText()}`);
  }
}
