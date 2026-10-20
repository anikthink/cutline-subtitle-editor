export class CueList {
  constructor(element, renderRow) {
    this.element = element; this.renderRow = renderRow; this.rows = []; this.heights = new Map(); this.prefix = [0]; this.version = 0;
    element.addEventListener('scroll', () => this.render());
    this.observer = new ResizeObserver(entries => {
      let changed = false;
      for (const entry of entries) {
        const id = entry.target.dataset.id, height = entry.target.getBoundingClientRect().height;
        if (height > 0 && Math.abs((this.heights.get(id) ?? 80) - height) > 1) { this.heights.set(id, height); changed = true; }
      }
      if (changed) {
        const index = this.indexAt(this.element.scrollTop), offset = this.element.scrollTop - this.prefix[index];
        this.rebuild(); this.element.scrollTop = this.prefix[index] + offset; this.version++; this.render();
      }
    });
    new ResizeObserver(() => { this.heights.clear(); this.rebuild(); this.version++; this.render(); }).observe(element);
  }
  indexAt(position) {
    let low = 0, high = this.rows.length;
    while (low < high) { const mid = (low + high) >> 1; if (this.prefix[mid + 1] <= position) low = mid + 1; else high = mid; }
    return Math.min(low, Math.max(0, this.rows.length - 1));
  }
  rebuild() {
    this.prefix = [0];
    for (const row of this.rows) this.prefix.push(this.prefix.at(-1) + (this.heights.get(row.cue.id) ?? 80));
  }
  setRows(rows, reset = false) {
    this.rows = rows; this.rebuild(); this.version++;
    if (reset) this.element.scrollTop = 0;
    this.render();
  }
  render(force = false) {
    const start = Math.max(0, this.indexAt(this.element.scrollTop) - 5);
    const end = Math.min(this.rows.length, this.indexAt(this.element.scrollTop + (this.element.clientHeight || 600)) + 7);
    const key = `${start}:${end}:${this.version}`;
    if (!force && key === this.lastKey) return;
    this.lastKey = key;
    const focused = this.element.contains(document.activeElement) ? document.activeElement.dataset.id : null;
    this.observer.disconnect();
    if (!this.rows.length) this.element.innerHTML = '<div class="empty-state" style="position:relative;margin:60px auto">No subtitles in this view.</div>';
    else this.element.innerHTML = `<div class="virtual-space" role="presentation" style="height:${this.prefix[start]}px"></div>` +
      this.rows.slice(start, end).map(this.renderRow).join('') +
      `<div class="virtual-space" role="presentation" style="height:${this.prefix.at(-1) - this.prefix[end]}px"></div>`;
    for (const row of this.element.querySelectorAll('.cue-row')) this.observer.observe(row);
    if (focused) this.element.querySelector(`[data-id="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
  }
  reveal(id, center = false) {
    const index = this.rows.findIndex(row => row.cue.id === id);
    if (index < 0) return;
    const top = this.prefix[index], bottom = this.prefix[index + 1], height = this.element.clientHeight;
    if (center) this.element.scrollTop = Math.max(0, top - (height - (bottom - top)) / 2);
    else if (top < this.element.scrollTop) this.element.scrollTop = top;
    else if (bottom > this.element.scrollTop + height) this.element.scrollTop = bottom - height;
    this.render();
  }
}
