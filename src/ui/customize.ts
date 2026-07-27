// Customize Campaign (S38+, doc §9, OQ15a): seed + presets + five basic
// knobs with the rest behind an ADVANCED accordion, a LIVE PREVIEW rendered
// through the PRODUCTION generator + renderer (no parallel implementation to
// drift), feasible() named-knob prechecks, and a visible reject card when a
// generation genuinely fails. Generate & Play hands the chosen spec to the
// campaign; the same values persist in the save and reproduce the theater.
import { DEFAULT_PRESET, PRESETS, type Preset } from '../campaign/presets';
import { feasible, makeTheater, TheaterGenError } from '../strategic/theatergen';
import type { CampaignConfig, TheaterConfig } from '../campaign/spec';
import { parseSeed, rollSeed } from './seed';
import { TheaterView } from '../render/theater-view';
import type { FrontV2 } from '../strategic/theater/force';

export interface CustomizeCallbacks {
  onGenerate(seed: number, theaterCfg: TheaterConfig, campaignCfg: CampaignConfig): void;
  onBack(): void;
}

// [key, label, values] — knob rows render as segmented buttons; values are
// the EXACT union members of the config fields (no clamping, no invention).
const BASIC_THEATER: [keyof TheaterConfig, string, (number | string)[]][] = [
  ['sizeKm', 'Theater size (km)', [18, 24, 32]],
  ['riverDensity', 'Rivers', [1, 2, 3]],
  ['roadDensity', 'Roads', [0, 1, 2, 3]],
  ['townDensity', 'Towns', [1, 2, 3, 4, 5, 6]],
];
const BASIC_CAMPAIGN: [keyof CampaignConfig, string, (number | string | boolean)[]][] = [
  ['warDays', 'War length (days)', [7, 14, 21, 30]],
  ['redStrength', 'Enemy strength', [0, 1, 2, 3, 4]],
];
const ADV_THEATER: [keyof TheaterConfig, string, (number | string)[]][] = [
  ['crossingScarcity', 'Crossing scarcity', [0, 1, 2]],
  ['railDensity', 'Rail', [0, 1, 2]],
  ['townSpacingMinKm', 'Town spacing (km)', [2, 3, 4, 5]],
  ['terrainMix', 'Terrain mix', ['bocage', 'open', 'wooded', 'marshland']],
  ['woodsShare', 'Woods share', [1, 2, 3, 4]],
];
const ADV_CAMPAIGN: [keyof CampaignConfig, string, (number | string | boolean)[]][] = [
  ['victory', 'Victory', ['objectives', 'majority']],
  ['blueCompanies', 'US companies', [2, 3, 4]],
  ['redDoctrine', 'Enemy doctrine', ['defensive', 'offensive']],
];

export class CustomizeScreen {
  private readonly el: HTMLDivElement;
  private theaterCfg: TheaterConfig = { ...DEFAULT_PRESET.theater };
  private campaignCfg: CampaignConfig = { ...DEFAULT_PRESET.campaign };
  private seedText = '';
  private presetName: string = DEFAULT_PRESET.name;
  private advancedOpen = false;
  private previewTimer: number | null = null;
  private previewSeedShown = -1;
  private _open = false;

  constructor(private readonly cb: CustomizeCallbacks) {
    this.el = document.createElement('div');
    this.el.id = 'customize';
    this.el.style.display = 'none';
    document.body.appendChild(this.el);
  }

  get isOpen(): boolean {
    return this._open;
  }

  open(): void {
    this._open = true;
    if (this.seedText === '') this.seedText = String(rollSeed());
    this.render();
    this.el.style.display = 'flex';
    this.schedulePreview(0);
  }

  close(): void {
    this._open = false;
    this.el.style.display = 'none';
    if (this.previewTimer !== null) window.clearTimeout(this.previewTimer);
    this.previewTimer = null;
  }

  private seed(): number {
    return parseSeed(this.seedText);
  }

  private applyPreset(p: Preset): void {
    this.presetName = p.name;
    this.theaterCfg = { ...p.theater };
    this.campaignCfg = { ...p.campaign };
  }

  private markCustom(): void {
    if (PRESETS.some((p) => p.name === this.presetName)) this.presetName = `Custom (from ${this.presetName})`;
  }

  private schedulePreview(delayMs = 250): void {
    if (this.previewTimer !== null) window.clearTimeout(this.previewTimer);
    this.previewTimer = window.setTimeout(() => this.drawPreview(), delayMs);
  }

  // The preview IS the production path: makeTheater + TheaterView, a dummy
  // front with the initial control and zero forces.
  private drawPreview(): void {
    const canvas = this.el.querySelector<HTMLCanvasElement>('#cz-preview');
    const card = this.el.querySelector<HTMLElement>('#cz-reject');
    if (!canvas || !card) return;
    const f = feasible(this.theaterCfg, this.campaignCfg);
    if (!f.ok) {
      card.textContent = `Infeasible: ${f.reason} — adjust '${f.knob}'`;
      card.style.display = 'block';
      return;
    }
    try {
      const t0 = performance.now();
      const { theater, initialControlByNode } = makeTheater(this.seed(), this.theaterCfg);
      const view = new TheaterView(theater);
      const front: FrontV2 = {
        theater,
        clockMin: 360,
        day: 1,
        nextForceId: 0,
        nextBattleId: 0,
        forces: [],
        controlByNode: [...initialControlByNode],
        battles: [],
        events: [],
        defileQueues: {},
      };
      const ctx = canvas.getContext('2d')!;
      view.draw(ctx, front, -1, true, 1, canvas.width, canvas.height);
      card.style.display = 'none';
      this.previewSeedShown = this.seed();
      const genMs = performance.now() - t0;
      const meta = this.el.querySelector<HTMLElement>('#cz-meta');
      if (meta) meta.textContent = `${theater.name} · ${theater.nodes.length} places · generated in ${genMs.toFixed(0)}ms`;
    } catch (e) {
      if (e instanceof TheaterGenError) {
        card.textContent = `${e.message}`;
        card.style.display = 'block';
        return;
      }
      throw e;
    }
  }

  private knobRow<T extends object>(cfg: T, key: keyof T, label: string, values: unknown[]): string {
    const current = cfg[key];
    const btns = values
      .map(
        (v) =>
          `<button class="hbtn cz-knob${String(v) === String(current) ? ' active' : ''}" data-knob="${String(key)}" data-value="${String(v)}">${String(v)}</button>`,
      )
      .join('');
    return `<div class="cz-row"><span class="cz-label">${label}</span><span class="cz-btns">${btns}</span></div>`;
  }

  private render(): void {
    const presetBtns = PRESETS.map(
      (p) => `<button class="hbtn cz-preset${p.name === this.presetName ? ' active' : ''}" data-preset="${p.name}">${p.name}</button>`,
    ).join('');
    const basic =
      BASIC_THEATER.map(([k, l, v]) => this.knobRow(this.theaterCfg, k, l, v)).join('') +
      BASIC_CAMPAIGN.map(([k, l, v]) => this.knobRow(this.campaignCfg, k, l, v)).join('');
    const adv =
      ADV_THEATER.map(([k, l, v]) => this.knobRow(this.theaterCfg, k, l, v)).join('') +
      ADV_CAMPAIGN.map(([k, l, v]) => this.knobRow(this.campaignCfg, k, l, v)).join('');
    const f = feasible(this.theaterCfg, this.campaignCfg);

    this.el.innerHTML = `<div class="cz-panel">
      <h1>CUSTOMIZE CAMPAIGN</h1>
      <div class="cz-row"><span class="cz-label">Seed</span>
        <span class="cz-btns"><input id="cz-seed" type="text" value="${this.seedText.replace(/"/g, '&quot;')}" spellcheck="false">
        <button class="hbtn" id="cz-roll">Roll</button></span></div>
      <div class="cz-row"><span class="cz-label">Preset</span><span class="cz-btns">${presetBtns}</span></div>
      <div class="cz-presetname">${this.presetName}</div>
      ${basic}
      <button class="hbtn cz-adv-toggle" id="cz-adv">${this.advancedOpen ? '▾' : '▸'} Advanced</button>
      <div id="cz-advanced" style="display:${this.advancedOpen ? 'block' : 'none'}">${adv}</div>
      <div class="cz-actions">
        <button class="hbtn" id="cz-back">Back</button>
        <button class="hbtn primary" id="cz-go" ${f.ok ? '' : 'disabled'}>Generate &amp; Play</button>
      </div>
      <div id="cz-reject" style="display:none"></div>
    </div>
    <div class="cz-side">
      <canvas id="cz-preview" width="560" height="420"></canvas>
      <div id="cz-meta"></div>
    </div>`;

    this.el.querySelector('#cz-roll')!.addEventListener('click', () => {
      this.seedText = String(rollSeed());
      this.render();
      this.schedulePreview(0);
    });
    this.el.querySelector<HTMLInputElement>('#cz-seed')!.addEventListener('input', (e) => {
      this.seedText = (e.target as HTMLInputElement).value;
      this.schedulePreview();
    });
    this.el.querySelector('#cz-adv')!.addEventListener('click', () => {
      this.advancedOpen = !this.advancedOpen;
      this.render();
      this.schedulePreview(0);
    });
    this.el.querySelector('#cz-back')!.addEventListener('click', () => this.cb.onBack());
    this.el.querySelector('#cz-go')!.addEventListener('click', () => {
      this.cb.onGenerate(this.seed(), { ...this.theaterCfg }, { ...this.campaignCfg });
    });
    for (const btn of Array.from(this.el.querySelectorAll('[data-preset]'))) {
      btn.addEventListener('click', () => {
        this.applyPreset(PRESETS.find((p) => p.name === btn.getAttribute('data-preset'))!);
        this.render();
        this.schedulePreview(0);
      });
    }
    for (const btn of Array.from(this.el.querySelectorAll('[data-knob]'))) {
      btn.addEventListener('click', () => {
        const key = btn.getAttribute('data-knob')!;
        const raw = btn.getAttribute('data-value')!;
        const numeric = /^-?\d+$/.test(raw) ? Number(raw) : raw === 'true' ? true : raw === 'false' ? false : raw;
        if (key in this.theaterCfg) (this.theaterCfg as unknown as Record<string, unknown>)[key] = numeric;
        else (this.campaignCfg as unknown as Record<string, unknown>)[key] = numeric;
        this.markCustom();
        this.render();
        this.schedulePreview();
      });
    }
  }
}
