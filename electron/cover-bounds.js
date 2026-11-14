'use strict';

// Turns the blocked window's native bounds into the dip rect the cover
// should occupy. Pure module: Electron's screen functions are injected by
// main.js so the placement rules stay testable under plain Node.

function intersect(a, b) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= x || bottom <= y) return null;
  return { x, y, width: right - x, height: bottom - y };
}

// The part of the rect that lies on any display, as one bounding box: a
// window spanning two displays keeps one rect across both.
function clipToDisplays(rect, displays) {
  const parts = displays.map((display) => intersect(rect, display.bounds)).filter(Boolean);
  if (!parts.length) return null;
  const x = Math.min(...parts.map((part) => part.x));
  const y = Math.min(...parts.map((part) => part.y));
  const right = Math.max(...parts.map((part) => part.x + part.width));
  const bottom = Math.max(...parts.map((part) => part.y + part.height));
  return { x, y, width: right - x, height: bottom - y };
}

function nearestDisplay(displays, cursor) {
  if (!displays.length) return { x: 0, y: 0, width: 0, height: 0 };
  const point = cursor || { x: 0, y: 0 };
  let best = displays[0];
  let bestDist = Infinity;
  for (const display of displays) {
    const b = display.bounds;
    const dx = point.x < b.x ? b.x - point.x : point.x >= b.x + b.width ? point.x - (b.x + b.width - 1) : 0;
    const dy = point.y < b.y ? b.y - point.y : point.y >= b.y + b.height ? point.y - (b.y + b.height - 1) : 0;
    const dist = dx * dx + dy * dy;
    if (dist < bestDist) {
      bestDist = dist;
      best = display;
    }
  }
  return { ...best.bounds };
}

function valid(bounds) {
  return Boolean(bounds)
    && Number.isFinite(bounds.x) && Number.isFinite(bounds.y)
    && Number.isFinite(bounds.width) && Number.isFinite(bounds.height)
    && bounds.width > 0 && bounds.height > 0;
}

// { rect, fallback }: the dip rect the cover takes, and whether it is the
// display-under-cursor fallback rather than the real window bounds (macOS
// without Accessibility, Wayland, any failed read).
function coverRect({ bounds, platform, displays, cursor, toDipRect, toDipPoint }) {
  let rect = null;
  if (valid(bounds)) {
    if (bounds.unit === 'physical' && platform === 'win32' && toDipRect) {
      // Mixed monitor scaling needs Electron's rect conversion, not a divide.
      const r = toDipRect({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
      rect = { x: r.x, y: r.y, width: r.width, height: r.height };
    } else if (bounds.unit === 'physical' && toDipPoint) {
      const tl = toDipPoint({ x: bounds.x, y: bounds.y });
      const br = toDipPoint({ x: bounds.x + bounds.width, y: bounds.y + bounds.height });
      rect = { x: tl.x, y: tl.y, width: br.x - tl.x, height: br.y - tl.y };
    } else {
      rect = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
    }
    rect = {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
    rect = clipToDisplays(rect, displays || []);
  }
  if (!rect) return { rect: nearestDisplay(displays || [], cursor), fallback: true };
  return { rect, fallback: false };
}

module.exports = { coverRect };
