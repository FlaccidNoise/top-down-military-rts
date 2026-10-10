import type { Keymap } from './keymap';
import { CONTEXT, DEFAULTS, formatBinding, LABEL, rebind, saveKeymap } from './keymap';
import { MOBILE } from '../render/view';
import { controlRows } from './manual-data';
import { esc } from './mainmenu';

export class PauseMenu {
  private el: HTMLDivElement;
  private _open = false;
  private cb: {
    onResume(): void;
    onKeymapChanged(k: Keymap): void;
    onFieldManual(): void;
    tutorialEnabled?(): boolean;
    onTutorialToggle?(on: boolean): void;
    muted(): boolean;
    onMuteToggle(): void;
    barksOn(): boolean;
    onBarksToggle(on: boolean): void;
    inTraining(): boolean;
    onLeaveTraining(): void;
  };
  private km: Keymap = { bindings: { ...DEFAULTS }, version: 0 };
  private captureActive = false;
  private captureAction: string | null = null;
  private captureHandler: ((e: KeyboardEvent) => void) | null = null;

  constructor(cb: {
    onResume(): void;
    onKeymapChanged(k: Keymap): void;
    onFieldManual(): void;
    tutorialEnabled?(): boolean;
    onTutorialToggle?(on: boolean): void;
    /** Sound. A phone has no M key, so the menu is its only switch. */
    muted(): boolean;
    onMuteToggle(): void;
    /** Barks: the words over a man at key moments (src/render/barks.ts owns the setting). */
    barksOn(): boolean;
    onBarksToggle(on: boolean): void;
    /** The drill is the battle on screen: the menu then offers the way out of it. */
    inTraining(): boolean;
    onLeaveTraining(): void;
  }) {
    this.cb = cb;
    this.el = document.createElement('div');
    this.el.id = 'pausemenu';
    this.el.style.display = 'none';
    document.body.appendChild(this.el);
  }

  get isOpen(): boolean { return this._open; }

  setKeymap(km: Keymap): void {
    this.km = { bindings: { ...km.bindings }, version: km.version };
    if (this._open) this.render();
  }

  /** `view` picks the screen it opens on: the menu, or straight to the controls card. */
  open(view: 'menu' | 'controls' = 'menu'): void {
    this._open = true;
    if (view === 'controls') this.renderControls();
    else this.render();
    this.el.style.display = 'flex';
  }

  close(): void {
    this._open = false;
    this.el.style.display = 'none';
    this.cancelCapture();
    this.cb.onResume();
  }

  toggle(): void {
    if (this._open) this.close();
    else this.open();
  }

  private render(): void {
    this.el.innerHTML = this.mainView();
    this.el.querySelector('#pm-resume')?.addEventListener('click', () => this.close());
    this.el.querySelector('#pm-controls')?.addEventListener('click', () => this.renderControls());
    this.el.querySelector('#pm-keybindings')?.addEventListener('click', () => this.showKeybindings());
    // Opens the manual OVER this menu. close() resumes the game, so it must not
    // run here — the player reads while the battle stays stopped.
    this.el.querySelector('#pm-manual')?.addEventListener('click', () => this.cb.onFieldManual());
    this.el.querySelector('#pm-tutorial')?.addEventListener('click', () => {
      this.cb.onTutorialToggle?.(!this.cb.tutorialEnabled!());
      this.render(); // the label IS the state
    });
    this.el.querySelector('#pm-sound')?.addEventListener('click', () => {
      this.cb.onMuteToggle();
      this.render();
    });
    this.el.querySelector('#pm-barks')?.addEventListener('click', () => {
      this.cb.onBarksToggle(!this.cb.barksOn());
      this.render();
    });
    this.el.querySelector('#pm-leave')?.addEventListener('click', () => {
      this.close();
      this.cb.onLeaveTraining();
    });
  }

  private mainView(): string {
    return `<div class="db"><div class="pm-panel">
      <h1>PAUSED</h1>
      <div class="db-actions">
        <button id="pm-resume" class="primary">Resume</button>
        <button id="pm-controls">Controls</button>
        ${MOBILE ? '' : '<button id="pm-keybindings">Keybindings</button>'}
        <button id="pm-manual">Field Manual</button>
        <button id="pm-sound" aria-pressed="${!this.cb.muted()}">Sound: ${this.cb.muted() ? 'OFF' : 'ON'}</button>
        ${this.cb.tutorialEnabled ? `<button id="pm-tutorial" aria-pressed="${this.cb.tutorialEnabled()}">Tutorial: ${this.cb.tutorialEnabled() ? 'ON' : 'OFF'}</button>` : ''}
        <button id="pm-barks" aria-pressed="${this.cb.barksOn()}">Barks: ${this.cb.barksOn() ? 'ON' : 'OFF'}</button>
        ${this.cb.inTraining() ? '<button id="pm-leave">Leave training</button>' : ''}
      </div>
      ${this.cb.tutorialEnabled && !this.cb.tutorialEnabled() ? '<p class="pm-note">Training is on the main menu.</p>' : ''}
    </div></div>`;
  }

  // The controls card: every binding, one table, read from the manual's own
  // Controls chapter with the player's bindings. The player's platform leads.
  private renderControls(): void {
    const rows = controlRows(this.km.bindings);
    const mine = MOBILE ? 'touch' : 'desktop';
    const other = MOBILE ? 'desktop' : 'touch';
    const body = rows.length
      ? rows.map((r) => `<tr><th>${esc(r.action)}</th><td>${esc(r[mine])}</td><td class="pm-other">${esc(r[other])}</td></tr>`).join('')
      : '<tr><td>No controls are listed.</td></tr>';
    this.el.innerHTML = `<div class="db-scroll"><div class="db"><div class="pm-panel">
      <h1>CONTROLS</h1>
      <table class="pm-controls">
        <tr><th></th><th>${MOBILE ? 'Touch' : 'Keyboard and mouse'}</th><th class="pm-other">${MOBILE ? 'Keyboard and mouse' : 'Touch'}</th></tr>
        ${body}
      </table>
    </div></div></div>
    <div class="db-actions">
      <button id="pm-resume" class="primary">Resume</button>
      <button id="pm-back">Menu</button>
    </div>`;
    this.el.querySelector('#pm-resume')?.addEventListener('click', () => this.close());
    this.el.querySelector('#pm-back')?.addEventListener('click', () => this.render());
  }

  private showKeybindings(): void {
    this.renderKeybindings();
  }

  private renderKeybindings(): void {
    const groups: { label: string; ctx: 'global' | 'battle' | 'strategic'; ids: string[] }[] = [
      { label: 'GLOBAL', ctx: 'global', ids: Object.keys(CONTEXT).filter((k) => CONTEXT[k as keyof typeof CONTEXT] === 'global') },
      { label: 'BATTLE', ctx: 'battle', ids: Object.keys(CONTEXT).filter((k) => CONTEXT[k as keyof typeof CONTEXT] === 'battle') },
      { label: 'STRATEGIC', ctx: 'strategic', ids: Object.keys(CONTEXT).filter((k) => CONTEXT[k as keyof typeof CONTEXT] === 'strategic') },
    ];

    const rows = groups.map((g) => {
      const entries = g.ids.map((id) => {
        const b = this.km.bindings[id as keyof typeof DEFAULTS];
        const fmt = formatBinding(b);
        const label = LABEL[id as keyof typeof LABEL];
        return `<div class="pm-row"><span>${label}</span><button class="hbtn pm-bind" data-action="${id}">${fmt}</button></div>`;
      }).join('');
      return `<div class="pm-group"><h3>${g.label}</h3>${entries}</div>`;
    }).join('');

    this.el.innerHTML = `<div class="db-scroll"><div class="db"><div class="pm-panel">
      <h1>KEYBINDINGS</h1>
      ${rows}
      <div class="db-actions">
        <button id="pm-reset">Reset to defaults</button>
        <button id="pm-back" class="primary">Back</button>
      </div>
    </div></div></div>`;

    this.el.querySelector('#pm-back')?.addEventListener('click', () => { this.cancelCapture(); this.render(); });
    this.el.querySelector('#pm-reset')?.addEventListener('click', () => {
      this.cancelCapture();
      this.km.bindings = { ...DEFAULTS };
      this.km.version++;
      saveKeymap(this.km, localStorage);
      this.cb.onKeymapChanged(this.km);
      this.renderKeybindings();
    });

    this.el.querySelectorAll('.pm-bind').forEach((btn) => {
      btn.addEventListener('click', () => {
        const action = (btn as HTMLElement).dataset.action!;
        this.startCapture(action, btn as HTMLButtonElement);
      });
    });
  }

  private startCapture(action: string, btn: HTMLButtonElement): void {
    this.cancelCapture();
    this.captureAction = action;
    this.captureActive = true;
    const orig = btn.textContent!;
    btn.textContent = 'press a key…';
    btn.style.color = 'var(--amber-bright)';

    this.captureHandler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === 'Escape') {
        this.cancelCapture();
        btn.textContent = orig;
        btn.style.color = '';
        return;
      }
      const b = { code: e.code, shift: e.shiftKey };
      rebind(this.km, action as keyof typeof DEFAULTS, b);
      this.km.version++;
      saveKeymap(this.km, localStorage);
      this.cb.onKeymapChanged(this.km);
      this.cancelCapture();
      this.renderKeybindings();
    };

    window.addEventListener('keydown', this.captureHandler, true);
  }

  private cancelCapture(): void {
    if (this.captureHandler) {
      window.removeEventListener('keydown', this.captureHandler, true);
      this.captureHandler = null;
    }
    this.captureActive = false;
    this.captureAction = null;
  }
}
