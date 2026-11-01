'use strict';

// Shared helpers for the per-OS foreground readers.

function cleanTitle(raw) {
  return String(raw || '')
    .replace(/\u200b|\u200e|\u200f/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

module.exports = { cleanTitle };
