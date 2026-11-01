(function () {
  'use strict';

  const CHECK = '<svg viewBox="0 0 11 11" aria-hidden="true"><path d="m1.6 5.6 2.4 2.4L9.4 2.6"/></svg>';
  const CHEVRON = '<svg class="chev" viewBox="0 0 13 13" aria-hidden="true"><path d="m3 5 3.5 3.5L10 5"/></svg>';
  const EXTERNAL = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M4 2.5h5.5V8M9.5 2.5 3.5 8.5"/></svg>';

  const MONTHS = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  const SHORT_DAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });
  const MONTH = new Intl.DateTimeFormat('en-GB', { month: 'long' });
  const TIME = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
  const TIME_WITH_SECONDS = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

  const state = {
    snapshot: null,
    route: 'today',
    ranges: { apps: 7, sites: 7 },
    openApp: null,
    openGroup: 'recording',
    savedAt: 0,
    enter: true,
    loadError: false,
    diagOpen: false,
  };

  const view = document.getElementById('view');
  const dialog = document.getElementById('confirm-dialog');
  const api = window.tally || createDemoApi();

  /* ---------- small DOM helpers ---------- */

  function h(tag, props, ...children) {
    const node = document.createElement(tag);
    if (props) {
      for (const [key, value] of Object.entries(props)) {
        if (value === null || value === undefined || value === false) continue;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'html') node.innerHTML = value;
        else if (key === 'dataset') Object.assign(node.dataset, value);
        else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
        else node.setAttribute(key, value === true ? '' : value);
      }
    }
    for (const child of children.flat(Infinity)) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  // Brand glyphs are bundled monochrome SVGs in app/icons (source: thesvg.org),
  // painted through a mask so every one inherits the same ink. Names come from
  // electron/tracker/apps.js; unknown apps and sites get an empty slot.
  const APP_GLYPHS = {
    'google chrome': 'chrome',
    chrome: 'chrome',
    'microsoft edge': 'edge',
    edge: 'edge',
    brave: 'brave',
    firefox: 'firefox',
    vivaldi: 'vivaldi',
    opera: 'opera',
    'opera gx': 'opera-gx',
    arc: 'arc',
    zen: 'zen',
    'visual studio code': 'code',
    'vs code insiders': 'code',
    cursor: 'cursor',
    'visual studio': 'visual-studio',
    'intellij idea': 'intellij',
    pycharm: 'pycharm',
    webstorm: 'webstorm',
    powershell: 'powershell',
    warp: 'warp',
    slack: 'slack',
    discord: 'discord',
    'microsoft teams': 'teams',
    teams: 'teams',
    zoom: 'zoom',
    figma: 'figma',
    notion: 'notion',
    obsidian: 'obsidian',
    linear: 'linear',
    trello: 'trello',
    miro: 'miro',
    loom: 'loom',
    airtable: 'airtable',
    canva: 'canva',
    framer: 'framer',
    webflow: 'webflow',
    photoshop: 'photoshop',
    blender: 'blender',
    word: 'word',
    excel: 'excel',
    powerpoint: 'powerpoint',
    outlook: 'outlook',
    spotify: 'spotify',
    steam: 'steam',
    telegram: 'telegram',
    whatsapp: 'whatsapp',
    '1password': '1password',
    bitwarden: 'bitwarden',
    raycast: 'raycast',
    terminal: 'terminal',
  };

  const SITE_GLYPHS = {
    'youtube.com': 'youtube',
    'youtu.be': 'youtube',
    'github.com': 'github',
    'gist.github.com': 'github',
    'gitlab.com': 'gitlab',
    'mail.google.com': 'gmail',
    'google.com': 'google',
    'linear.app': 'linear',
    'mozilla.org': 'mozilla',
    'news.ycombinator.com': 'ycombinator',
    'reddit.com': 'reddit',
    'wikipedia.org': 'wikipedia',
    'stackoverflow.com': 'stackoverflow',
    'chatgpt.com': 'chatgpt',
    'chat.openai.com': 'chatgpt',
    'claude.ai': 'claude',
    'notion.so': 'notion',
    'figma.com': 'figma',
    'slack.com': 'slack',
    'discord.com': 'discord',
    'spotify.com': 'spotify',
    'open.spotify.com': 'spotify',
    'netflix.com': 'netflix',
    'linkedin.com': 'linkedin',
    'amazon.com': 'amazon',
    'twitch.tv': 'twitch',
    'x.com': 'x',
    'twitter.com': 'x',
    'instagram.com': 'instagram',
    'facebook.com': 'facebook',
    'tiktok.com': 'tiktok',
    'medium.com': 'medium',
    'substack.com': 'substack',
    'duckduckgo.com': 'duckduckgo',
    'bing.com': 'bing',
    'threads.net': 'threads',
    'vercel.com': 'vercel',
    'npmjs.com': 'npm',
    'nodejs.org': 'nodejs',
    'python.org': 'python',
    'rust-lang.org': 'rust',
    'go.dev': 'go',
    'docker.com': 'docker',
    'supabase.com': 'supabase',
    'firebase.google.com': 'firebase',
    'cloudflare.com': 'cloudflare',
    'canva.com': 'canva',
    'trello.com': 'trello',
    'miro.com': 'miro',
    'loom.com': 'loom',
    'airtable.com': 'airtable',
    'framer.com': 'framer',
    'webflow.com': 'webflow',
    'teams.microsoft.com': 'teams',
    'zoom.us': 'zoom',
    'outlook.com': 'outlook',
    'outlook.office.com': 'outlook',
    '1password.com': '1password',
    'bitwarden.com': 'bitwarden',
    'raycast.com': 'raycast',
    'warp.dev': 'warp',
    'cursor.com': 'cursor',
    'code.visualstudio.com': 'code',
    'obsidian.md': 'obsidian',
  };

  const BROWSER_GLYPHS = ['chrome', 'edge', 'brave', 'vivaldi', 'opera', 'opera-gx', 'firefox', 'zen', 'arc'];

  function glyph(key, className = 'glyph') {
    if (!key) return h('span', { class: 'tile tile-empty', 'aria-hidden': 'true' });
    return h('span', { class: 'tile', 'aria-hidden': 'true' },
      h('span', { class: className, style: `--glyph: url("icons/${key}.svg")` }));
  }

  function appGlyph(name, className) {
    return glyph(APP_GLYPHS[String(name || '').toLowerCase()] || null, className);
  }

  function siteGlyph(domain, className) {
    const host = String(domain || '').toLowerCase().replace(/^www\./, '');
    const parts = host.split('.');
    for (let i = 0; i < parts.length - 1; i++) {
      const key = SITE_GLYPHS[parts.slice(i).join('.')];
      if (key) return glyph(key, className);
    }
    return glyph(null, className);
  }

  function browserGlyph(id, className) {
    return glyph(BROWSER_GLYPHS.includes(id) ? id : null, className);
  }

  /* ---------- figures ---------- */

  function durationParts(seconds) {
    const raw = Math.max(0, Number(seconds) || 0);
    if (raw < 1) return { h: 0, m: 0, under: false };
    const total = Math.round(raw);
    if (total < 60) return { h: 0, m: 0, under: true };
    let hours = Math.floor(total / 3600);
    let minutes = Math.round((total % 3600) / 60);
    if (minutes === 60) { hours += 1; minutes = 0; }
    return { h: hours, m: minutes, under: false };
  }

  function durationText(seconds) {
    const p = durationParts(seconds);
    if (p.under) return '< 1 m';
    if (p.h && p.m) return `${p.h} h ${p.m} m`;
    if (p.h) return `${p.h} h`;
    return `${p.m} m`;
  }

  // Hours and minutes as counter wheels, e.g. [0][4] h [1][2] m. Used for the
  // large total on Today, Apps and Websites; size comes from the parent class.
  function counter(seconds, className = '') {
    const p = durationParts(seconds);
    const wheels = (value) => h('span', { class: 'wheels' },
      String(value).padStart(2, '0').split('').map((digit) => h('span', { class: 'wheel', text: digit })));
    return h('div', {
      class: `counter num ${className}`.trim(),
      role: 'img',
      'aria-label': p.under ? 'Under a minute' : durationText(seconds),
    },
    wheels(p.h), h('span', { class: 'u', text: 'h' }),
    wheels(p.m), h('span', { class: 'u', text: 'm' }));
  }

  function share(part, whole) {
    const value = whole ? (Number(part) / Number(whole)) * 100 : 0;
    return {
      value,
      text: value > 0 && value < 0.5 ? '<1%' : `${Math.round(value)}%`,
      width: value > 0 ? Math.max(0.6, Math.min(100, value)) : 0,
    };
  }

  function pctText(part, whole) {
    return share(part, whole).text;
  }

  function plural(count, one, many) {
    return `${count} ${count === 1 ? one : many}`;
  }

  function shortName(name) {
    return String(name || '').replace(/^(Google|Microsoft|Mozilla)\s+/, '');
  }

  // The app that was counted most recently today. The tracker only knows what it
  // has counted in this run, so a fresh session would otherwise claim nothing was
  // ever counted while the day already holds hours.
  function lastCountedName(day) {
    let best = null;
    for (const app of Object.values((day && day.apps) || {})) {
      if (!best || (Number(app.lastAt) || 0) > (Number(best.lastAt) || 0)) best = app;
    }
    return best ? best.name : null;
  }

  function timeOf(iso) {
    if (!iso) return null;
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return null;
    return TIME.format(date);
  }

  function clockOf(ms, withSeconds = false) {
    if (!ms) return '—';
    const date = new Date(Number(ms));
    if (Number.isNaN(date.getTime())) return '—';
    return (withSeconds ? TIME_WITH_SECONDS : TIME).format(date);
  }

  function dayLabel(key) {
    if (!key) return '';
    const [y, m, d] = key.split('-').map(Number);
    return MONTHS.format(new Date(y, m - 1, d, 12));
  }

  function shortDayLabel(key) {
    if (!key) return '';
    const [y, m, d] = key.split('-').map(Number);
    return SHORT_DAY.format(new Date(y, m - 1, d, 12));
  }

  function keyToDate(key) {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d, 12);
  }

  function rangeLabel(days, todayKey) {
    if (days === 1) return dayLabel(todayKey);
    const end = keyToDate(todayKey);
    const start = new Date(end);
    start.setDate(end.getDate() - (days - 1));
    if (start.getMonth() === end.getMonth()) return `${start.getDate()} – ${end.getDate()} ${MONTH.format(end)}`;
    return `${start.getDate()} ${MONTH.format(start)} – ${end.getDate()} ${MONTH.format(end)}`;
  }

  function formatBytes(bytes) {
    if (!bytes) return '0 KB';
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function totalOf(rows) {
    return rows.reduce((sum, row) => sum + (Number(row.seconds) || 0), 0);
  }

  function mediaCeilingLabel(minutes) {
    if (minutes === null || minutes === undefined) return 'never';
    if (minutes < 60) return `${minutes} minutes`;
    if (minutes === 60) return '1 hour';
    return `${minutes / 60} hours`;
  }

  /* ---------- page shell ---------- */

  // Screen title with its date or range beside it, and controls on the right.
  function pageHead({ title, meta, right }) {
    return h('header', { class: 'page-head' },
      h('div', { class: 'title-line' },
        h('h1', { text: title }),
        meta ? h('span', { class: 'head-meta', text: meta }) : null),
      right ? h('div', { class: 'head-right' }, right) : null);
  }

  function rangeControl(kind, value) {
    const options = [[1, '1 day'], [7, '7 days'], [30, '30 days']];
    return h('div', { class: 'seg', role: 'group', 'aria-label': 'Time range' },
      options.map(([days, label]) => h('button', {
        type: 'button',
        class: value === days ? 'on' : null,
        'aria-pressed': String(value === days),
        onclick: () => {
          if (state.ranges[kind] === days) return;
          state.ranges[kind] = days;
          if (kind === 'apps') state.openApp = null;
          state.enter = true;
          render();
        },
      }, label)));
  }

  function listEmpty(lines, action) {
    return h('div', { class: 'list-empty' },
      lines.map((line) => h('p', { text: line })),
      action || null);
  }

  /* ---------- today ---------- */

  function renderToday(snap) {
    const data = snap.today;
    const yesterday = snap.yesterday || { totalSeconds: 0 };
    const now = new Date(snap.now || Date.now());

    const header = pageHead({
      title: 'Today',
      meta: dayLabel(snap.todayKey),
      right: snap.settings.paused ? [h('span', { class: 'stamp', text: 'Paused' })] : null,
    });

    const summary = h('section', { class: 'summary slab' },
      h('div', { class: 'total-block' },
        counter(data.totalSeconds, 'counter-lg'),
        h('div', { class: 'sub' },
          data.browserSeconds > 0
            ? [h('b', { class: 'num', text: durationText(data.browserSeconds) }), ' in browsers']
            : (data.totalSeconds > 0 ? 'No browser time today' : 'Nothing recorded yet today'))),
      h('dl', { class: 'mini' },
        h('div', null,
          h('dt', { text: 'Yesterday' }),
          h('dd', { class: 'num', text: yesterday.totalSeconds ? durationText(yesterday.totalSeconds) : '—' }))));

    const hours = hourBlock(data, now);
    const lists = h('div', { class: 'lists' }, appList(data, snap), siteList(data, snap));

    return h('div', { class: 'page-inner' },
      header,
      h('div', { class: 'page-body' },
        h('div', { class: 'stack' }, summary, hours, lists)));
  }

  function hourBlock(data, now) {
    const hasData = data.totalSeconds > 0;
    const nowHour = now.getHours();
    const futureWidth = Math.max(0, ((23 - nowHour) / 24) * 100);
    const columns = [];

    for (let hour = 0; hour < 24; hour++) {
      const seconds = Number((data.hours || [])[hour]) || 0;
      const minutes = Math.min(60, seconds / 60);
      const live = hour <= nowHour;
      const height = live && minutes > 0 ? Math.max(1.5, Math.min(100, (minutes / 60) * 100)) : 0;
      columns.push(h('div', { class: 'col' },
        h('div', {
          class: `bar${hour === nowHour ? ' now' : ''}`,
          style: `height:${height}%`,
          title: `${String(hour).padStart(2, '0')}:00 – ${Math.round(seconds / 60)} m`,
          role: 'presentation',
        })));
    }

    const peak = hasData ? data.hours.indexOf(Math.max(...data.hours)) : -1;
    const meta = hasData
      ? h('div', { class: 'hours-meta' },
        h('span', { class: 'num', text: `Busiest ${String(peak).padStart(2, '0')}–${String((peak + 1) % 24).padStart(2, '0')} · ${Math.round(data.hours[peak] / 60)} m` }),
        h('span', { class: 'faint num', text: `First ${timeOf(data.firstAt) || '—'} · Last ${timeOf(data.lastAt) || '—'}` }))
      : h('div', { class: 'hours-meta' }, h('span', { class: 'faint', text: 'Nothing recorded yet today.' }));

    const labelAt = (hour) => hour % 3 === 0;

    const axis = h('div', { class: 'axis', 'aria-hidden': 'true' },
      Array.from({ length: 24 }, (_, hour) => h('div', { class: `cell${labelAt(hour) ? ' on' : ''}` },
        labelAt(hour) ? h('span', { text: String(hour).padStart(2, '0') }) : null)));

    return h('section', { class: 'hours slab' },
      h('div', { class: 'hours-head' },
        h('div', { class: 'hours-title', text: 'By hour' }),
        meta),
      h('div', { class: 'screen' },
      h('div', {
        class: 'chart',
        role: 'img',
        'aria-label': hasData
          ? `Minutes recorded each hour today. Busiest hour ${String(peak).padStart(2, '0')}:00 with ${Math.round(data.hours[peak] / 60)} minutes.`
          : 'No minutes recorded yet today.',
      },
        futureWidth ? h('div', { class: 'future', style: `width:${futureWidth}%`, 'aria-hidden': 'true' }) : null,
        columns),
      axis));
  }

  function appList(data, snap) {
    const total = data.totalSeconds;
    const apps = data.apps;
    const shown = apps.slice(0, 6);
    const rest = apps.slice(6);
    const restSeconds = totalOf(rest);
    const rows = shown.map((app) => itemRow({
      glyph: appGlyph(app.name),
      name: app.name,
      seconds: app.seconds,
      whole: total,
    }));

    if (restSeconds > 0.5) {
      rows.push(itemRow({
        glyph: glyph(null),
        name: `Other apps (${rest.length})`,
        seconds: restSeconds,
        whole: total,
        other: true,
      }));
    }

    return h('section', { class: 'list slab' },
      h('div', { class: 'list-head' },
        h('div', { class: 'list-title', text: 'Apps' }),
        apps.length ? h('div', { class: 'list-meta num', text: plural(apps.length, 'app', 'apps') }) : null),
      apps.length
        ? rows
        : listEmpty([snap.settings.paused
          ? 'Tracking is paused, so nothing is being recorded.'
          : 'Nothing recorded yet today. Open an app and Tally will list it here.']));
  }

  function siteList(data, snap) {
    const total = data.browserSeconds;
    const sites = data.sites;
    const shown = sites.slice(0, 6);
    const rest = sites.slice(6);
    const restSeconds = totalOf(rest);
    const namedSeconds = totalOf(sites);
    const unattributed = Math.max(0, total - namedSeconds);
    const rows = shown.map((site) => itemRow({
      glyph: siteGlyph(site.domain),
      name: site.domain,
      seconds: site.seconds,
      whole: total,
    }));

    if (restSeconds > 0.5) {
      rows.push(itemRow({
        glyph: glyph(null),
        name: `Other sites (${rest.length})`,
        seconds: restSeconds,
        whole: total,
        other: true,
      }));
    }
    if (unattributed > 0.5) {
      rows.push(itemRow({
        glyph: glyph(null),
        name: 'Unmatched',
        seconds: unattributed,
        whole: total,
        other: true,
      }));
    }

    let empty = null;
    if (!snap.settings.recordWebsites) {
      empty = listEmpty(
        ['Website names are turned off.', 'Browser time still counts, without a domain.'],
        h('button', { class: 'link-btn', type: 'button', onclick: () => go('settings') }, 'Turn on website names'));
    } else if (!total) {
      empty = listEmpty(['No browser time yet today.', 'Time in a browser will be matched to the page it shows.']);
    }

    return h('section', { class: 'list slab' },
      h('div', { class: 'list-head' },
        h('div', { class: 'list-title', text: 'Websites' }),
        sites.length ? h('div', { class: 'list-meta num', text: plural(sites.length, 'site', 'sites') }) : null),
      empty && !rows.length ? empty : rows,
      empty && rows.length ? h('div', { class: 'list-foot' }, empty) : null);
  }

  function itemRow({ glyph: mark, name, seconds, whole, other = false }) {
    const part = share(seconds, whole);
    return h('div', { class: `item${other ? ' other' : ''}` },
      mark || null,
      h('div', { class: 'item-main' },
        h('div', { class: 'item-line' },
          h('span', { class: 'item-name', text: name, title: name }),
          h('span', { class: 'item-time num', text: durationText(seconds) }),
          h('span', { class: 'item-pct num', text: part.text })),
        h('div', { class: 'track' }, h('i', { style: `width:${part.width}%` }))));
  }

  /* ---------- apps ---------- */

  function renderApps(snap) {
    const days = state.ranges.apps;
    const data = snap.ranges[days] || snap.today;
    const total = data.totalSeconds;
    const apps = data.apps;

    const header = pageHead({
      title: 'Apps',
      meta: rangeLabel(days, snap.todayKey),
      right: [rangeControl('apps', days)],
    });

    const top = apps.slice(0, 5);
    const topSeconds = totalOf(top);
    const remainder = Math.max(0, total - topSeconds);
    const strip = total
      ? h('div', { class: 'strip', 'aria-hidden': 'true', title: 'Each app’s share of the total' },
        top.map((app) => h('i', {
          style: `width:${share(app.seconds, total).width}%`,
        })),
        remainder > 0.5 ? h('i', { class: 'rest', style: `width:${share(remainder, total).width}%` }) : null)
      : null;

    const context = h('aside', { class: 'ctx slab' },
      counter(total),
      h('div', { class: 'ctx-sub', text: total
        ? `Across ${plural(apps.length, 'app', 'apps')}, ${days === 1 ? 'today' : `${days} days`}`
        : 'Nothing recorded in this range' }),
      strip);

    const openKey = state.openApp;
    const rows = apps.slice(0, 8);
    const restSeconds = Math.max(0, total - totalOf(rows));

    const table = h('div', { class: 'table slab' },
      h('div', { class: 'thead' },
        h('span'),
        h('span'),
        h('span', { text: 'App' }),
        h('span', { class: 'r', text: 'Time' }),
        h('span', { class: 'lh', text: 'Share' }),
        h('span', { class: 'r', text: '%' }),
        h('span')),
      apps.length
        ? rows.map((app, index) => {
          const open = app.key === openKey;
          return [
            h('button', {
              type: 'button',
              class: `trow${open ? ' open' : ''}`,
              'aria-expanded': String(open),
              onclick: () => {
                state.openApp = open ? null : app.key;
                render();
              },
            },
            h('span', { class: 'idx num', text: String(index + 1).padStart(2, '0') }),
            appGlyph(app.name),
            h('span', { class: 'name', text: app.name, title: app.name }),
            h('span', { class: 'time num', text: durationText(app.seconds) }),
            h('span', { class: 'track' }, h('i', { style: `width:${share(app.seconds, total).width}%` })),
            h('span', { class: 'pct num', text: pctText(app.seconds, total) }),
            h('span', { class: 'chev-wrap', html: CHEVRON })),
            open ? h('div', { class: 'title-row' },
              h('div', { class: 'title-v', text: app.title || 'No window title recorded' }),
              app.lastAt ? h('div', { class: 'title-t num', text: `Last seen ${SHORT_DAY.format(new Date(app.lastAt))}, ${clockOf(app.lastAt)}` }) : null) : null,
          ];
        })
        : h('div', { class: 'table-empty' },
          listEmpty(['Nothing recorded in this range.', days === 1
            ? 'Today has only just started, or tracking is paused.'
            : 'Try a shorter range, or leave Tally running in the tray.'])),
      apps.length && restSeconds > 0.5
        ? h('div', { class: 'trow other' },
          h('span', { class: 'idx num', text: String(Math.min(rows.length, 8) + 1).padStart(2, '0') }),
          glyph(null),
          h('span', { class: 'name', text: `Other apps (${apps.length - rows.length})` }),
          h('span', { class: 'time num', text: durationText(restSeconds) }),
          h('span', { class: 'track' }, h('i', { style: `width:${share(restSeconds, total).width}%` })),
          h('span', { class: 'pct num', text: pctText(restSeconds, total) }),
          h('span'))
        : null);

    return h('div', { class: 'page-inner' }, header,
      h('div', { class: 'page-body' }, h('div', { class: 'split' }, context, table)));
  }

  // Share strips tell parts apart by dither texture, not colour: densest for
  // the largest part. Textures live in dither.css (scripts/make-dither.js).
  const STRIP_TEXTURES = ['solid', 'l75', 'l50', 'dotted', 'hatched'];

  // Class list for part `index` of a strip; -1 is the remainder.
  function texture(index) {
    return `tex tex-${index < 0 ? 'l12' : STRIP_TEXTURES[index % STRIP_TEXTURES.length]}`;
  }

  /* ---------- websites ---------- */

  function renderSites(snap) {
    const days = state.ranges.sites;
    const data = snap.ranges[days] || snap.today;
    const total = data.browserSeconds;
    const sites = data.sites;
    const shown = sites.slice(0, 6);
    const rest = sites.slice(6);
    const restSeconds = totalOf(rest);
    const namedSeconds = totalOf(sites);
    const unattributed = Math.max(0, total - namedSeconds);

    const header = pageHead({
      title: 'Websites',
      meta: rangeLabel(days, snap.todayKey),
      right: [rangeControl('sites', days)],
    });

    const rows = shown.map((site) => siteRow({
      glyph: siteGlyph(site.domain),
      name: site.domain,
      detail: site.title ? `${shortName(site.browser || 'Browser')} · ${site.title}` : shortName(site.browser || 'Browser'),
      seconds: site.seconds,
      whole: total,
    }));

    if (restSeconds > 0.5) {
      rows.push(siteRow({
        glyph: glyph(null),
        name: 'Other sites',
        detail: `${plural(rest.length, 'site', 'sites')} below this list`,
        seconds: restSeconds,
        whole: total,
        other: true,
      }));
    }
    if (unattributed > 0.5) {
      rows.push(siteRow({
        glyph: glyph(null),
        name: 'Unmatched browser time',
        detail: snap.settings.recordWebsites ? 'No recent match in history' : 'Naming is turned off',
        seconds: unattributed,
        whole: total,
        dashed: true,
      }));
    }

    const figureRow = h('div', { class: 'sites-figure slab' },
      counter(total),
      h('div', { class: 'ctx-sub', text: total ? `in browsers across ${plural(sites.length, 'site', 'sites')}` : 'No browser time in this range' }));

    let empty = null;
    if (!snap.settings.recordWebsites) {
      empty = listEmpty(
        ['Website names are turned off.', 'Tally still counts every browser as an app. Names come only from local browser history.'],
        h('button', { class: 'link-btn', type: 'button', onclick: () => go('settings') }, 'Turn on website names'));
    } else if (!total) {
      empty = listEmpty(['No website time recorded in this range.', 'Website names come from the history file of the browser in front.']);
    }

    const body = h('section', { class: 'sites' },
      figureRow,
      h('div', { class: 'site-list slab' },
        rows.length ? rows : null,
        empty ? h('div', { class: 'sites-empty' }, empty) : null,
        browserSplit(data, total)));

    return h('div', { class: 'page-inner' }, header,
      h('div', { class: 'page-body' }, body));
  }

  function siteRow({ glyph: mark, name, detail, seconds, whole, other = false, dashed = false }) {
    const part = share(seconds, whole);
    return h('div', { class: `site${other ? ' other' : ''}${dashed ? ' unattributed' : ''}` },
      h('div', { class: 'site-line' },
        mark || null,
        h('span', { class: 'site-name', text: name, title: name }),
        h('span', { class: 'site-time num', text: durationText(seconds) }),
        h('span', { class: 'site-pct num', text: part.text }),
        h('span', { class: 'site-detail', text: detail, title: detail })),
      h('div', { class: `track${dashed ? ' dashed' : ''}` }, dashed ? null : h('i', { style: `width:${part.width}%` })));
  }

  function browserSplit(data, total) {
    const rows = (data.apps || []).filter((app) => app.browser && app.seconds > 0);
    if (!rows.length || !total) return null;
    const ordered = [...rows].sort((a, b) => b.seconds - a.seconds);
    const top = ordered.slice(0, 4);
    const restSeconds = totalOf(ordered.slice(4));
    const pieces = top.map((app, index) => ({
      name: shortName(app.browser),
      seconds: app.seconds,
      texture: texture(index),
    }));
    if (restSeconds > 0.5) pieces.push({ name: 'Other', seconds: restSeconds, texture: texture(-1) });

    return h('div', { class: 'browser-split' },
      h('div', { class: 'label', text: 'By browser' }),
      h('div', { class: 'split-strip', 'aria-hidden': 'true' },
        pieces.map((piece) => h('i', { class: piece.texture, style: `width:${share(piece.seconds, total).width}%` }))),
      h('div', { class: 'split-legend' },
        pieces.map((piece) => h('span', null,
          h('i', { class: `swatch ${piece.texture}`, 'aria-hidden': 'true' }),
          h('b', { text: piece.name }),
          h('span', { class: 'num', text: durationText(piece.seconds) })))));
  }

  /* ---------- settings ---------- */

  function renderSettings(snap) {
    const settings = snap.settings;
    const system = snap.system;
    const tracking = snap.tracking;
    const reason = reasonOf(tracking, settings);
    const saved = Date.now() - state.savedAt < 2600;
    const platform = system.platform === 'win32'
      ? `Windows${system.arch ? ` ${system.arch === 'x64' ? 'x64' : system.arch}` : ''}`
      : system.platform === 'darwin'
        ? `macOS${system.arch ? ` ${system.arch}` : ''}`
        : system.platform === 'linux'
          ? `Linux${system.arch ? ` ${system.arch}` : ''}`
          : (system.platform || 'Desktop');

    const header = pageHead({
      title: 'Settings',
      right: saved ? [h('span', { class: 'stamp', text: 'Saved' })] : null,
    });

    const index = [
      ['recording', 'Recording'],
      ['appearance', 'Appearance'],
      ['websites', 'Websites'],
      ['data', 'Data'],
      ['about', 'About'],
    ];

    const indexRail = h('aside', { class: 'index', 'aria-label': 'Settings sections' },
      index.map(([key, label]) => h('button', {
        type: 'button',
        class: state.openGroup === key ? 'on' : null,
        onclick: () => {
          state.openGroup = key;
          document.querySelectorAll('.index button').forEach((button) => {
            button.classList.toggle('on', button.dataset.group === key);
          });
          const target = document.getElementById(`group-${key}`);
          if (target) target.scrollIntoView({ block: 'start', behavior: smoothScroll() });
        },
        dataset: { group: key },
      }, label)));

    const browsers = system.browserList || [];
    const installed = browsers.filter((browser) => browser.installed);
    const enabled = settings.browsers === null ? installed.map((browser) => browser.id) : settings.browsers;

    const diagnostics = h('details', {
      class: 'diag',
      open: state.diagOpen,
      ontoggle: (event) => { state.diagOpen = event.target.open; },
    },
    h('summary', null, h('span', { html: CHEVRON }), 'Diagnostics'),
    h('div', { class: 'readout' },
      readoutCell('State', STATES[reason].label),
      readoutCell('Last sample', clockOf(tracking.lastSampleAt, true), true),
      readoutCell('Idle poll', tracking.idle ? '20 s' : `${tracking.sampling || settings.sampleSeconds} s`, true),
      readoutCell('Media sessions', tracking.mediaAvailable === false
        ? 'Unavailable'
        : tracking.mediaSessions == null ? 'Not read' : `${tracking.mediaSessions} detected`, true)));

    const recording = h('section', { class: 'group slab', id: 'group-recording' },
      groupHead('Recording'),
      switchRow('Record screen time', 'Pause any time from the sidebar. Nothing is deleted.', !settings.paused,
        () => saveSettings({ paused: !settings.paused })),
      switchRow('Open Tally at login', 'Starts hidden in the tray when you sign in.', settings.launchAtLogin,
        () => saveSettings({ launchAtLogin: !settings.launchAtLogin })),
      h('div', { class: 'fields' },
        fieldSelect('Sample every',
          [[5, '5 seconds'], [10, '10 seconds'], [30, '30 seconds']],
          settings.sampleSeconds,
          (value) => saveSettings({ sampleSeconds: Number(value) })),
        fieldSelect('Ignore idle time after',
          [[60, '1 minute'], [120, '2 minutes'], [300, '5 minutes'], [600, '10 minutes']],
          settings.idleSeconds,
          (value) => saveSettings({ idleSeconds: Number(value) })),
        fieldSelect('Stop counting media after',
          [[30, '30 minutes'], [60, '1 hour'], [120, '2 hours'], [240, '4 hours'], ['never', 'Never']],
          settings.mediaCeilingMinutes == null ? 'never' : settings.mediaCeilingMinutes,
          (value) => saveSettings({ mediaCeilingMinutes: value === 'never' ? null : Number(value) }))),
      h('p', { class: 'field-hint', text: tracking.mediaAvailable === false
        ? 'Media sessions are not readable on this build, so idle time is measured from keyboard and mouse only.'
        : 'Playing media keeps counting without input until this limit.' }),
      diagnostics);

    const accessibility = system.platform === 'darwin' ? (system.permissions && system.permissions.accessibility) : null;

    const websites = h('section', { class: 'group slab', id: 'group-websites' },
      groupHead('Websites', plural(installed.length, 'browser', 'browsers')),
      switchRow('Record website names', 'Matched from each browser’s local history. Nothing is uploaded.',
        settings.recordWebsites, () => saveSettings({ recordWebsites: !settings.recordWebsites })),
      system.platform === 'darwin'
        ? h('div', { class: 'row' },
          h('div', null,
            h('div', { class: 'row-t', text: 'Window titles' }),
            h('div', { class: 'row-d', text: accessibility
              ? 'Allowed in System Settings › Privacy & Security › Accessibility.'
              : 'Tally needs Accessibility access to read window titles, which is how it names websites.' })),
          accessibility
            ? null
            : h('div', { class: 'row-r' },
              h('button', {
                class: 'btn',
                type: 'button',
                onclick: async () => {
                  await api.requestAccessibility();
                  await refresh();
                },
              }, 'Allow…')))
        : null,
      installed.length
        ? h('div', { class: 'browsers' }, installed.map((browser) => h('label', { class: 'browser' },
          h('input', {
            class: 'check-input',
            type: 'checkbox',
            checked: enabled.includes(browser.id),
            onchange: (event) => {
              const next = new Set(enabled);
              if (event.target.checked) next.add(browser.id);
              else next.delete(browser.id);
              const all = installed.every((row) => next.has(row.id)) ? null : [...next];
              saveSettings({ browsers: all });
            },
          }),
          h('span', { class: 'check', html: CHECK }),
          browserGlyph(browser.id),
          h('span', { class: 'bn', text: browser.name }))))
        : h('p', { class: 'note', text: 'No supported browser found yet.' }),
      h('button', {
        class: 'link-btn',
        type: 'button',
        onclick: async () => {
          const list = await api.rescanBrowsers();
          state.snapshot.system.browserList = list;
          render();
        },
      }, 'Rescan browsers'));

    const theme = settings.theme && typeof settings.theme === 'object' ? settings.theme : { preset: 'default' };
    const appearance = h('section', { class: 'group slab', id: 'group-appearance' },
      groupHead('Appearance'),
      h('div', { class: 'row' },
        h('div', null,
          h('div', { class: 'row-t', text: 'Theme' }),
          h('div', { class: 'row-d', text: 'A preset repaints the palette. Custom lets you pick your own colours.' })),
        h('div', { class: 'row-r' },
          h('select', {
            class: 'select',
            'aria-label': 'Theme',
            onchange: (event) => saveSettings({ theme: { ...theme, preset: event.target.value } }),
          },
          THEME_OPTIONS.map(([value, label]) => h('option', {
            value,
            selected: theme.preset === value,
          }, label))))),
      theme.preset === 'custom'
        ? h('div', { class: 'fields' },
          fieldColor('Accent', theme.accent, '#e8e8e8',
            (value) => saveSettings({ theme: { ...theme, accent: value } })),
          fieldColor('Background', theme.ground, '#080808',
            (value) => saveSettings({ theme: { ...theme, ground: value } })),
          fieldColor('Text', theme.text, '#ffffff',
            (value) => saveSettings({ theme: { ...theme, text: value } })))
        : null);

    const oldest = system.oldestDay;
    const dataGroup = h('section', { class: 'group slab', id: 'group-data' },
      groupHead('Data', formatBytes(system.fileSize || 0)),
      h('div', { class: 'row' },
        h('div', null,
          h('div', { class: 'row-t', text: 'Keep history for' }),
          h('div', { class: 'row-d', text: 'Older days are deleted automatically.' })),
        h('div', { class: 'row-r' },
          h('select', {
            class: 'select',
            'aria-label': 'Keep history for',
            onchange: (event) => saveSettings({ retentionDays: Number(event.target.value) }),
          },
          [[30, '30 days'], [90, '90 days'], [365, '1 year']].map(([value, label]) => h('option', {
            value,
            selected: Number(settings.retentionDays) === value,
          }, label))))),
      h('div', { class: 'stats' },
        h('div', null, h('div', { class: 'k', text: 'Days stored' }), h('div', { class: 'v num', text: String(system.storedDays || 0) })),
        h('div', null, h('div', { class: 'k', text: 'Oldest day' }), h('div', { class: 'v num', text: oldest ? shortDayLabel(oldest) : '—' }))),
      h('div', { class: 'row' },
        h('div', null,
          h('div', { class: 'row-t danger', text: 'Delete all data' }),
          h('div', { class: 'row-d', text: 'Removes every day and starts empty. This cannot be undone.' })),
        h('div', { class: 'row-r' },
          h('button', { class: 'btn btn-danger', type: 'button', onclick: () => dialog.showModal() }, 'Delete data…'))));

    const update = system.update || { supported: false };
    const about = h('section', { class: 'group slab', id: 'group-about' },
      groupHead('About'),
      h('p', { class: 'about', text: update.supported
        ? 'Tally keeps one JSON file on this computer. No account and no upload. Its only network traffic is for updates: checking GitHub for a new version and downloading it, and only while updates are on.'
        : 'Tally keeps one JSON file on this computer. No account, no upload, no network requests.' }),
      update.supported
        ? [
          switchRow('Install updates automatically', 'Downloads new versions from GitHub and installs them when Tally quits.',
            settings.autoUpdate !== false, () => saveSettings({ autoUpdate: settings.autoUpdate === false })),
          updateRow(update),
        ]
        : null,
      h('div', { class: 'about-meta' },
        h('span', { class: 'num', text: `Tally ${system.version}` }),
        h('span', { class: 'num', text: platform })),
      h('div', { class: 'about-path num', text: system.dataPath }),
      h('div', { class: 'about-actions' },
        h('button', {
          class: 'link-btn',
          type: 'button',
          onclick: () => api.openDataFolder(),
        }, 'Show data folder', h('span', { class: 'ext', html: EXTERNAL }))));

    const panel = h('div', { class: 'panel' }, recording, appearance, websites, dataGroup, about);

    return h('div', { class: 'page-inner' },
      header,
      h('div', { class: 'page-body' },
        h('div', { class: 'settings' }, indexRail, panel)));
  }

  // One line on where updating stands, with the action that fits it.
  function updateRow(update) {
    const copy = updateCopy(update);
    if (!copy) return null;
    const action = update.status === 'ready'
      ? h('button', { class: 'btn', type: 'button', onclick: () => api.installUpdate() }, 'Restart to update')
      : update.enabled && update.status !== 'checking' && update.status !== 'downloading'
        ? h('button', { class: 'link-btn', type: 'button', onclick: () => checkForUpdates() }, 'Check now')
        : null;
    return h('div', { class: 'row' },
      h('div', null,
        h('div', { class: 'row-t', text: copy.title }),
        copy.detail ? h('div', { class: 'row-d', text: copy.detail }) : null),
      action ? h('div', { class: 'row-r' }, action) : null);
  }

  function updateCopy(update) {
    const checked = update.checkedAt ? `Checked ${clockOf(update.checkedAt)}` : null;
    switch (update.status) {
      case 'checking': return { title: 'Checking for updates…' };
      case 'downloading': return { title: `Downloading ${update.version || 'update'}`, detail: `${update.percent || 0}%` };
      case 'ready': return { title: `Version ${update.version} is ready`, detail: 'It installs when Tally quits, or restart now.' };
      case 'current': return { title: 'Tally is up to date', detail: checked };
      case 'error': return { title: 'Couldn’t check for updates', detail: update.error || checked };
      default: return update.enabled ? { title: 'Updates are on', detail: 'The first check runs shortly after Tally starts.' } : null;
    }
  }

  async function checkForUpdates() {
    try {
      const next = await api.checkForUpdates();
      if (next && state.snapshot) state.snapshot.system.update = next;
      render();
    } catch {
      // the next scheduled check will try again
    }
  }

  function groupHead(title, meta) {
    return h('div', { class: 'group-head' },
      h('h2', { class: 'group-t', text: title }),
      meta ? h('span', { class: 'group-m num', text: meta }) : null);
  }

  function readoutCell(label, value, numeric = false) {
    return h('div', null,
      h('span', { class: 'k', text: label }),
      h('span', { class: `v${numeric ? ' num' : ''}`, text: value }));
  }

  function smoothScroll() {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
  }

  function switchRow(title, description, checked, onChange) {
    return h('div', { class: 'row' },
      h('div', null,
        h('div', { class: 'row-t', text: title }),
        h('div', { class: 'row-d', text: description })),
      h('div', { class: 'row-r' },
        h('button', {
          class: 'switch',
          type: 'button',
          role: 'switch',
          'aria-checked': String(Boolean(checked)),
          'aria-label': title,
          onclick: onChange,
        })));
  }

  function fieldSelect(label, options, value, onChange) {
    return h('label', { class: 'field' },
      h('span', { class: 'k', text: label }),
      h('select', {
        class: 'select',
        onchange: (event) => onChange(event.target.value),
      },
      options.map(([optionValue, optionLabel]) => h('option', {
        value: optionValue,
        selected: String(optionValue) === String(value),
      }, optionLabel))));
  }

  function fieldColor(label, value, fallback, onChange) {
    return h('label', { class: 'field' },
      h('span', { class: 'k', text: label }),
      h('input', {
        class: 'swatch-input',
        type: 'color',
        'aria-label': label,
        value: isHex(value) ? value : fallback,
        onchange: (event) => onChange(event.target.value),
      }));
  }

  /* ---------- themes ---------- */

  // Presets paint the palette in app.css; custom derives one from three picks.
  const THEME_OPTIONS = [
    ['default', 'Ink (default)'],
    ['t3code', 'T3 Code'],
    ['t3chat', 'T3 Chat'],
    ['forest', 'Forest'],
    ['fire', 'Fire'],
    ['custom', 'Custom'],
  ];
  const THEME_IDS = new Set(THEME_OPTIONS.map(([id]) => id));

  const CUSTOM_VARS = [
    '--ground', '--glow', '--rail', '--surface', '--well', '--rule', '--border', '--control',
    '--slab', '--key', '--key-down', '--text', '--muted', '--faint', '--quiet',
    '--primary', '--accent', '--skeleton', '--dither-ink',
  ];

  const isHex = (value) => /^#[0-9a-f]{6}$/i.test(value || '');

  function mixHex(a, b, t) {
    const [ar, ag, ab] = [parseInt(a.slice(1, 3), 16), parseInt(a.slice(3, 5), 16), parseInt(a.slice(5, 7), 16)];
    const [br, bg2, bb] = [parseInt(b.slice(1, 3), 16), parseInt(b.slice(3, 5), 16), parseInt(b.slice(5, 7), 16)];
    return `#${[ar + (br - ar) * t, ag + (bg2 - ag) * t, ab + (bb - ab) * t]
      .map((n) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, '0')).join('')}`;
  }

  function applyTheme(theme) {
    const el = document.documentElement;
    const id = theme && THEME_IDS.has(theme.preset) ? theme.preset : 'default';
    el.dataset.theme = id;
    if (id !== 'custom') {
      for (const key of CUSTOM_VARS) el.style.removeProperty(key);
      return;
    }
    const bg = isHex(theme.ground) ? theme.ground : '#080808';
    const fg = isHex(theme.text) ? theme.text : '#ffffff';
    const ac = isHex(theme.accent) ? theme.accent : fg;
    const t = (x) => mixHex(bg, fg, x);
    const vars = {
      '--ground': bg,
      '--glow': t(0.07),
      '--rail': t(0.045),
      '--surface': t(0.07),
      '--well': mixHex(bg, '#000000', 0.25),
      '--rule': t(0.11),
      '--border': t(0.15),
      '--control': t(0.24),
      '--slab': `linear-gradient(180deg, ${t(0.085)} 0%, ${t(0.05)} 100%)`,
      '--key': `linear-gradient(180deg, ${t(0.17)} 0%, ${t(0.10)} 100%)`,
      '--key-down': `linear-gradient(180deg, ${t(0.06)} 0%, ${t(0.085)} 100%)`,
      '--text': fg,
      '--muted': mixHex(fg, bg, 0.20),
      '--faint': mixHex(fg, bg, 0.38),
      '--quiet': mixHex(fg, bg, 0.50),
      '--primary': ac,
      '--accent': ac,
      '--skeleton': t(0.05),
      '--dither-ink': mixHex(fg, bg, 0.07),
    };
    for (const [key, value] of Object.entries(vars)) el.style.setProperty(key, value);
  }

  /* ---------- tracker state ---------- */

  const STATES = {
    recording: { label: 'Recording', dot: true, why: 'Time is being added.' },
    media: { label: 'Media in foreground', dot: true, why: 'Time continues with no input.' },
    idle: { label: 'Idle', dot: false, why: 'No time added. Counting starts again on input.' },
    limit: { label: 'Media limit reached', dot: false, why: 'Media kept playing without input. Counting resumes when you touch the keyboard.' },
    paused: { label: 'Paused', dot: false, why: 'Nothing is being recorded. Resume when you want totals again.' },
    self: { label: 'Tally in front', dot: false, why: 'Tally is in front now, and is never counted.' },
    starting: { label: 'Starting', dot: false, why: 'Reading the app in front.' },
    unsupported: { label: 'Tracking unavailable', dot: false, why: 'Tracking isn’t available on this system.' },
    error: { label: 'Not recording', dot: false, why: 'The last read did not work.' },
  };

  function reasonOf(tracking, settings) {
    if (!tracking.supported) return 'unsupported';
    if (settings.paused) return 'paused';
    if (tracking.error) return 'error';
    return tracking.reason || (tracking.idle ? 'idle' : tracking.media ? 'media' : 'recording');
  }

  function stateCopy(snap) {
    const tracking = snap.tracking;
    const reason = reasonOf(tracking, snap.settings);
    const base = STATES[reason] || STATES.starting;
    const why = reason === 'recording' && state.route === 'sites' && snap.settings.recordWebsites
      ? 'Titles are read here on this computer.'
      : reason === 'recording' && tracking.app
        ? `${shortName(tracking.app)} is in front. Time is being added.`
        : reason === 'media' && tracking.app
          ? `${shortName(tracking.app)} is playing media. Time continues with no input.`
          : reason === 'limit'
            ? `${snap.settings.mediaCeilingMinutes == null ? 'The media limit is reached.' : `Media played for ${mediaCeilingLabel(snap.settings.mediaCeilingMinutes)} without input.`} Counting resumes when you touch the keyboard.`
            : reason === 'error' && tracking.error
              ? tracking.error
              : reason === 'unsupported' && tracking.error
                ? tracking.error
                : base.why;
    const label = reason === 'self'
      ? (() => {
          const counted = lastCountedName(snap.today) || tracking.app;
          return counted ? `Last counted · ${shortName(counted)}` : STATES.self.label;
        })()
      : base.label;
    return { reason, label, why, dot: base.dot };
  }

  function renderRailState() {
    const host = document.getElementById('rail-state');
    const snap = state.snapshot;
    if (!host || !snap) return;
    const copy = stateCopy(snap);
    const paused = snap.settings.paused;
    const canPause = snap.tracking.supported;

    const counting = copy.reason === 'recording' || copy.reason === 'media';
    const why = counting
      ? (snap.tracking.app ? shortName(snap.tracking.app) : null)
      : copy.reason === 'self' ? null : copy.why;

    const update = snap.system.update || {};
    const ready = update.status === 'ready'
      ? h('button', { class: 'state-action update-action', type: 'button', onclick: () => api.installUpdate() },
        `Restart to update to ${update.version}`)
      : null;

    host.replaceChildren(ready, h('div', { class: 'state' },
      h('div', { class: 'state-head' },
        h('span', { class: `dot${copy.dot ? '' : ' hollow'}` }),
        h('span', { class: 'state-label', text: copy.label, title: copy.label })),
      why ? h('p', { class: 'state-why', text: why, title: copy.why }) : null,
      canPause
        ? h('button', {
          class: 'state-action',
          type: 'button',
          onclick: () => saveSettings({ paused: !paused }),
        }, paused ? 'Resume recording' : 'Pause recording')
        : null));

    const note = document.getElementById('preview-note');
    if (note) note.hidden = !snap.tracking.demo;
  }

  /* ---------- render ---------- */

  // Draws the current route. Entrance motion plays only when state.enter is
  // set (first load, screen or range change), never on background refreshes.
  function render() {
    const snap = state.snapshot;
    renderNav();
    if (!snap) {
      view.setAttribute('aria-busy', String(!state.loadError));
      view.replaceChildren(state.loadError ? loadError() : skeleton(state.route));
      return;
    }
    view.removeAttribute('aria-busy');
    applyTheme(snap.settings && snap.settings.theme);
    const page = state.route === 'apps' ? renderApps(snap)
      : state.route === 'sites' ? renderSites(snap)
        : state.route === 'settings' ? renderSettings(snap)
          : renderToday(snap);
    if (state.enter) {
      page.classList.add('enter');
      state.enter = false;
    }
    view.replaceChildren(page);
    renderRailState();
  }

  // Static placeholder shaped like the screen that is loading.
  function skeleton(route) {
    const sk = (className) => h('span', { class: `sk ${className}` });
    const rows = (count) => Array.from({ length: count }, () => sk('sk-row'));
    const body = route === 'settings'
      ? [h('div', { style: 'margin-top:32px;max-width:720px' }, rows(8))]
      : route === 'today'
        ? [sk('sk-figure'), sk('sk-line'), sk('sk-chart'), rows(5)]
        : [sk('sk-figure'), h('div', { style: 'margin-top:32px' }, rows(7))];
    return h('div', { class: 'page-inner', 'aria-hidden': 'true' },
      sk('sk-title'), h('div', { class: 'page-body' }, body));
  }

  function loadError() {
    return h('div', { class: 'page-inner' },
      h('div', { class: 'page-body' },
        h('div', { class: 'load-error list-empty' },
        h('p', { text: 'Couldn’t read totals.' }),
        h('button', {
          class: 'link-btn',
          type: 'button',
          onclick: () => {
            state.loadError = false;
            render();
            refresh();
          },
        }, 'Retry'))));
  }

  function renderNav() {
    document.querySelectorAll('.nav-item').forEach((item) => {
      if (item.dataset.nav === state.route) item.setAttribute('aria-current', 'page');
      else item.removeAttribute('aria-current');
    });
  }

  /* ---------- actions ---------- */

  async function refresh() {
    try {
      const active = document.activeElement;
      const editing = state.route === 'settings' && active && view.contains(active) && /^(SELECT|INPUT)$/.test(active.tagName);
      state.snapshot = await api.snapshot();
      if (!editing) render();
      else renderRailState();
    } catch {
      // keep the last good screen rather than flashing an error over it;
      // only a first load with nothing to show offers a retry
      if (!state.snapshot) {
        state.loadError = true;
        render();
      }
    }
  }

  async function saveSettings(patch) {
    try {
      const result = await api.updateSettings(patch);
      if (result && result.settings) {
        state.snapshot.settings = { ...state.snapshot.settings, ...result.settings };
        state.snapshot.tracking = { ...state.snapshot.tracking, ...(result.tracking || {}) };
      }
      state.savedAt = Date.now();
      render();
      api.snapshot().then((snapshot) => {
        state.snapshot = snapshot;
        render();
      }).catch(() => {});
      setTimeout(() => {
        if (state.route === 'settings') render();
      }, 2600);
    } catch {
      // a failed write leaves the old value on screen
    }
  }

  function go(route) {
    if (window.location.hash !== `#/${route}`) window.location.hash = `#/${route}`;
    else {
      state.route = route;
      render();
    }
  }

  /* ---------- routing ---------- */

  function readRoute() {
    const hash = window.location.hash.replace(/^#\/?/, '');
    return ['today', 'apps', 'sites', 'settings'].includes(hash) ? hash : 'today';
  }

  window.addEventListener('hashchange', () => {
    state.route = readRoute();
    state.enter = true;
    render();
    const scroller = view.querySelector('.page-body');
    if (scroller) scroller.scrollTo({ top: 0 });
  });

  dialog.addEventListener('close', async () => {
    if (dialog.returnValue === 'delete') {
      await api.clearData();
      state.savedAt = Date.now();
      await refresh();
    }
  });

  api.onChanged(() => {
    if (!document.hidden) refresh();
  });
  setInterval(() => {
    if (!document.hidden) refresh();
  }, 60000);

  state.route = readRoute();
  render();
  refresh();

  /* ---------- preview bridge (opened outside Electron) ---------- */

  function createDemoApi() {
    const days = window.TallyDemo ? window.TallyDemo.buildDays(30) : { days: {} };
    const settings = {
      sampleSeconds: 5, idleSeconds: 120, mediaCeilingMinutes: 120, paused: false,
      recordWebsites: true, launchAtLogin: false, autoUpdate: true, retentionDays: 90, browsers: null,
      theme: { preset: 'default', accent: '', ground: '', text: '' },
    };
    const browserList = [
      { id: 'chrome', name: 'Google Chrome', profiles: 1, installed: true },
      { id: 'edge', name: 'Microsoft Edge', profiles: 1, installed: true },
      { id: 'brave', name: 'Brave', profiles: 0, installed: false },
      { id: 'vivaldi', name: 'Vivaldi', profiles: 0, installed: false },
      { id: 'opera', name: 'Opera', profiles: 0, installed: false },
      { id: 'opera-gx', name: 'Opera GX', profiles: 0, installed: false },
      { id: 'firefox', name: 'Firefox', profiles: 0, installed: false },
      { id: 'zen', name: 'Zen', profiles: 0, installed: false },
    ];
    const demoNow = new Date();
    const demoKey = window.TallyDemo ? window.TallyDemo.keyOf(demoNow) : '';

    function snapshot() {
      const today = window.TallyDemo.aggregate(days, 1);
      const yesterdayDate = new Date(demoNow.getFullYear(), demoNow.getMonth(), demoNow.getDate() - 1, 12);
      const yesterday = window.TallyDemo.aggregate({ [window.TallyDemo.keyOf(yesterdayDate)]: days[window.TallyDemo.keyOf(yesterdayDate)] }, 1, yesterdayDate);
      const keys = Object.keys(days).sort();
      return {
        now: new Date().toISOString(),
        todayKey: demoKey,
        today,
        yesterday,
        ranges: { 1: today, 7: window.TallyDemo.aggregate(days, 7), 30: window.TallyDemo.aggregate(days, 30) },
        settings,
        tracking: {
          supported: true, lastSampleAt: Date.now(), app: 'Google Chrome', site: 'youtube.com',
          title: 'How a mechanical watch works - YouTube', idleMs: 0, idle: false,
          media: true, mediaSessions: 2, mediaAvailable: true,
          reason: 'media', error: null, paused: settings.paused, sampling: 5, demo: true,
        },
        system: {
          platform: 'win32', arch: 'x64', version: '1.2.0',
          dataPath: 'C:\\Users\\you\\AppData\\Roaming\\Tally\\tally-data.json',
          browserList, supported: true, startedAt: new Date(Date.now() - 30 * 86400000).toISOString(),
          storedDays: keys.length, oldestDay: keys[0] || null, fileSize: JSON.stringify(days).length,
          update: {
            supported: true, enabled: settings.autoUpdate !== false, status: 'current',
            version: null, percent: 0, checkedAt: Date.now() - 42 * 60000, error: null,
          },
        },
      };
    }

    return {
      snapshot: async () => snapshot(),
      range: async (n) => window.TallyDemo.aggregate(days, n),
      updateSettings: async (patch) => {
        Object.assign(settings, patch);
        return { settings: { ...settings }, tracking: snapshot().tracking };
      },
      clearData: async () => {
        for (const key of Object.keys(days)) delete days[key];
        return true;
      },
      openDataFolder: async () => true,
      rescanBrowsers: async () => browserList,
      requestAccessibility: async () => false,
      installUpdate: async () => false,
      checkForUpdates: async () => snapshot().system.update,
      onChanged: () => () => {},
    };
  }
})();
