// Pulls the brand glyphs listed in app/icons/sources.json from thesvg.org.
// Run by hand (`bun run icons`) when the list changes; the SVGs are committed,
// so the app itself never touches the network.
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', 'app', 'icons');
const sources = JSON.parse(fs.readFileSync(path.join(DIR, 'sources.json'), 'utf8'));

async function main() {
  const entries = Object.entries(sources).filter(([key]) => !key.startsWith('_'));
  let written = 0;
  let failed = 0;

  for (const [key, { slug, variant }] of entries) {
    const url = `https://thesvg.org/icons/${slug}/${variant}.svg`;
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.text()).replace(/\r/g, '').trim();
      const start = body.indexOf('<svg');
      if (start === -1) throw new Error('not an SVG');
      const svg = body.slice(start);
      fs.writeFileSync(path.join(DIR, `${key}.svg`), `${svg}\n`);
      written++;
      console.log(`ok   ${key.padEnd(14)} ${slug}/${variant}`);
    } catch (error) {
      failed++;
      console.log(`FAIL ${key.padEnd(14)} ${slug}/${variant}: ${error.message}`);
    }
  }

  console.log(`\n${written} written, ${failed} failed, ${entries.length} listed.`);
  if (failed) process.exitCode = 1;
}

main();
