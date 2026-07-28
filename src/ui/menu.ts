import type { Keymap } from './keymap';
import { CONTEXT, DEFAULTS, formatBinding, LABEL, rebind, saveKeymap } from './keymap';
import { coach } from './coach';

export class PauseMenu {
  private el: HTMLDivElement;
  private _open = false;
  private cb: { onResume(): void; onKeymapChanged(k: Keymap): void; onFieldManual(): void };
  private km: Keymap = { bindings: { ...DEFAULTS }, version: 0 };
  private captureActive = false;
  private captureAction: string | null = null;
  private captureHandler: ((e: KeyboardEvent) => void) | null = null;

  constructor(cb: { onResume(): void; onKeymapChanged(k: Keymap): void; onFieldManual(): void }) {
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

  open(): void {
    this._open = true;
    this.render();
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
    this.el.querySelector('#pm-keybindings')?.addEventListener('click', () => this.showKeybindings());
    // Opens the manual OVER this menu. close() resumes the game, so it must not
    // run here — the player reads while the battle stays stopped.
    this.el.querySelector('#pm-manual')?.addEventListener('click', () => this.cb.onFieldManual());
  }

  private mainView(): string {
    return `<div class="db"><div class="pm-panel">
      <h1>PAUSED</h1>
      <div class="db-actions">
        <button id="pm-resume" class="primary">Resume</button>
        <button id="pm-keybindings">Keybindings</button>
        <button id="pm-manual">Field Manual</button>
      </div>
    </div></div>`;
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
        <button id="pm-coach-reset">Reset coachmarks</button>
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

    this.el.querySelector('#pm-coach-reset')?.addEventListener('click', () => {
      coach.dismissAll();
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
