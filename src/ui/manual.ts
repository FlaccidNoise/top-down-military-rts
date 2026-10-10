// The Field Manual screen. Renders src/ui/manual-data.ts and nothing else —
// no copy lives here. Opened only on demand (main menu, pause menu, tutorial),
// never on its own: the art sweep must never see it.
import { esc } from './mainmenu';
import { loadKeymap } from './keymap';
import { buildManual, MANUAL, type ManualChapter } from './manual-data';

/**
 * Case-insensitive substring match over chapter title, heading, body and both
 * key columns. A title hit keeps the whole chapter: the titles are the labels
 * the player reads in the rail, and typing one back must never answer that
 * nothing matches.
 */
export function filterManual(term: string, manual: ManualChapter[] = MANUAL): ManualChapter[] {
  const q = term.trim().toLowerCase();
  if (!q) return manual;
  return manual
    .map((c) => c.title.toLowerCase().includes(q) ? c : {
      ...c,
      entries: c.entries.filter((e) => {
        const keys = e.keys ? ` ${e.keys.desktop} ${e.keys.touch}` : '';
        return `${e.heading} ${e.body}${keys}`.toLowerCase().includes(q);
      }),
    })
    .filter((c) => c.entries.length > 0);
}

function chapterHtml(c: ManualChapter): string {
  const entries = c.entries.map((e) => {
    const keys = e.keys
      ? `<div class="mn-keys">
        <div class="mn-kcol"><span class="mn-klabel">Desktop</span><span class="mn-kval">${esc(e.keys.desktop)}</span></div>
        <div class="mn-kcol"><span class="mn-klabel">Touch</span><span class="mn-kval">${esc(e.keys.touch)}</span></div>
      </div>`
      : '';
    return `<article class="mn-entry"><h3>${esc(e.heading)}</h3><p>${esc(e.body)}</p>${keys}</article>`;
  }).join('');
  return `<section class="mn-ch" id="mn-ch-${c.id}"><h2>${esc(c.title)}</h2>${entries}</section>`;
}

export class ManualScreen {
  private el: HTMLDivElement;
  private _open = false;
  private term = '';
  private active = '';
  private manual: ManualChapter[] = MANUAL;
  private onKey: (e: KeyboardEvent) => void;

  constructor() {
    this.el = document.createElement('div');
    this.el.id = 'manual';
    this.el.style.display = 'none';
    document.body.appendChild(this.el);
    // The modal owns the keyboard while it is up: every key stops here, so the
    // game underneath never acts on a search term the player is typing.
    // stopPropagation does not cancel the default action, so the input types.
    this.onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.code === 'Escape') { e.preventDefault(); this.close(); }
    };
  }

  get isOpen(): boolean { return this._open; }

  /** Opens the manual, scrolled to `chapterId` when one is named. */
  open(chapterId?: string): void {
    this._open = true;
    this.term = '';
    this.active = chapterId ?? '';
    // Built on open with the player's own bindings: a rebound key reads as bound.
    this.manual = buildManual(loadKeymap(localStorage).bindings);
    this.render();
    this.el.style.display = 'flex';
    window.addEventListener('keydown', this.onKey, true);
    if (chapterId) this.scrollTo(chapterId);
  }

  close(): void {
    if (!this._open) return;
    this._open = false;
    this.el.style.display = 'none';
    window.removeEventListener('keydown', this.onKey, true);
  }

  private render(): void {
    this.el.innerHTML = `<div class="mn-head">
      <h1>FIELD MANUAL</h1>
      <input id="mn-search" type="search" placeholder="Search" autocomplete="off" aria-label="Search the manual">
      <button id="mn-close" aria-label="Close">×</button>
    </div>
    <div class="mn-body"><nav class="mn-rail"></nav><div class="mn-content"></div></div>`;

    this.el.querySelector('#mn-close')?.addEventListener('click', () => this.close());
    const search = this.el.querySelector('#mn-search') as HTMLInputElement;
    search.addEventListener('input', () => {
      this.term = search.value;
      this.active = '';
      this.renderBody();
      // A new result set starts at its first hit, not at the old scroll depth.
      this.el.querySelector('.mn-content')!.scrollTop = 0;
    });
    this.renderBody();
  }

  private renderBody(): void {
    const chapters = filterManual(this.term, this.manual);
    const rail = this.el.querySelector('.mn-rail')!;
    const content = this.el.querySelector('.mn-content')!;

    rail.innerHTML = chapters
      .map((c) => `<button class="mn-navi${c.id === this.active ? ' active' : ''}" data-ch="${c.id}">${esc(c.title)}</button>`)
      .join('');
    content.innerHTML = chapters.length
      ? chapters.map(chapterHtml).join('')
      : `<p class="mn-empty">No entries match &#39;${esc(this.term.trim())}&#39;.</p>`;

    rail.querySelectorAll('.mn-navi').forEach((b) => {
      b.addEventListener('click', () => {
        const id = (b as HTMLElement).dataset.ch!;
        this.active = id;
        this.renderBody();
        this.scrollTo(id);
      });
    });
  }

  private scrollTo(chapterId: string): void {
    this.el.querySelector(`#mn-ch-${chapterId}`)?.scrollIntoView({ block: 'start' });
  }
}
