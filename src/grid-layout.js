// Geometry only: identities and batch membership are supplied by the host.
export function buildPagedGridLayout({ items, batches, cols, cell, gap, gutter = 12 }) {
    const byId = new Map();
    const byIndex = [];
    const rows = [];
    const sections = [];
    const entries = new Map(items.map(item => [item.id, item]));
    const assigned = new Set();
    let top = 0;
    for (const batch of batches) {
        const members = batch.ids.map(id => entries.get(id)).filter(item => item && !assigned.has(item.id));
        if (!members.length) continue;
        const section = { id: batch.id, label: batch.label, top, height: 0 };
        // A small label row keeps page names out of thumbnail hit targets.
        top += 18;
        for (let start = 0; start < members.length; start += cols) {
            const row = { top, bottom: top + cell, indices: [] };
            for (let col = 0; col < cols && start + col < members.length; col++) {
                const item = members[start + col];
                assigned.add(item.id);
                const rect = { id: item.id, index: item.index, x: gutter + col * (cell + gap), y: top, width: cell, height: cell };
                byId.set(item.id, rect);
                byIndex[item.index] = rect;
                row.indices.push(item.index);
            }
            rows.push(row);
            top += cell + gap;
        }
        section.height = top - gap - section.top;
        sections.push(section);
        top += 4;
    }
    return { byId, byIndex, rows, sections, height: sections.length ? top - gap - 4 : 0, rowH: cell + gap };
}

export function pagedGridWindow(layout, top, height, overscan = 2) {
    const rows = layout.rows;
    const lower = top - overscan * layout.rowH;
    const upper = top + height + overscan * layout.rowH;
    let lo = 0, hi = rows.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (rows[mid].bottom < lower) lo = mid + 1;
        else hi = mid;
    }
    const indices = [];
    for (let row = lo; row < rows.length && rows[row].top <= upper; row++) indices.push(...rows[row].indices);
    return indices;
}
