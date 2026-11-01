// Believable sample days for the preview build and for screenshots. The desktop app never loads this:
// it starts with an honest empty day and fills from real foreground windows.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TallyDemo = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const CHROME = 'c:\\program files\\google\\chrome\\application\\chrome.exe';
  const CODE = 'c:\\users\\you\\appdata\\local\\programs\\microsoft vs code\\code.exe';
  const SLACK = 'c:\\users\\you\\appdata\\local\\slack\\slack.exe';
  const FIGMA = 'c:\\users\\you\\appdata\\local\\figma\\figma.exe';
  const SPOTIFY = 'c:\\users\\you\\appdata\\roaming\\spotify\\spotify.exe';
  const TERMINAL = 'c:\\users\\you\\appdata\\local\\microsoft\\windowsapps\\windowsterminal.exe';
  const NOTION = 'c:\\users\\you\\appdata\\local\\programs\\notion\\notion.exe';
  const TEAMS = 'c:\\users\\you\\appdata\\local\\microsoft\\teams\\current\\teams.exe';
  const EXPLORER = 'c:\\windows\\explorer.exe';
  const WORD = 'c:\\program files\\microsoft office\\root\\office16\\winword.exe';
  const MAIL = 'c:\\program files\\windowsapps\\microsoft.windowscommunicationsapps\\mail.exe';

  const TODAY_APPS = [
    [CHROME, 'Google Chrome', 'How a mechanical watch works - YouTube', 8400],
    [CODE, 'Visual Studio Code', 'app.js - tally - Visual Studio Code', 2700],
    [SLACK, 'Slack', 'screen-time - #design - Slack', 1200],
    [FIGMA, 'Figma', 'screen-time app screens - Figma', 720],
    [SPOTIFY, 'Spotify', 'Ambient focus - playlist', 600],
    [TERMINAL, 'Terminal', 'pwsh - 120x32', 420],
    [NOTION, 'Notion', 'Weekly plan - Notion', 360],
    [TEAMS, 'Microsoft Teams', 'Design sync | Microsoft Teams', 300],
    [EXPLORER, 'File Explorer', 'screen-time - File Explorer', 180],
    [WORD, 'Word', 'Q4 notes.docx - Word', 120],
    [MAIL, 'Mail', 'Inbox - Mail', 120],
  ];

  const TODAY_SITES = [
    ['youtube.com', 'How a mechanical watch works - YouTube', 'Google Chrome', 3360],
    ['github.com', 'screen-time: pull requests - GitHub', 'Google Chrome', 1440],
    ['mail.google.com', 'Inbox (3) - Gmail', 'Google Chrome', 1200],
    ['linear.app', 'screen-time - Linear', 'Google Chrome', 900],
    ['developer.mozilla.org', 'Intl.NumberFormat - MDN Web Docs', 'Google Chrome', 600],
    ['news.ycombinator.com', 'Hacker News', 'Google Chrome', 480],
    ['figma.com', 'screen-time app screens - Figma', 'Google Chrome', 180],
  ];

  // 07:00 to 17:00, in seconds
  const TODAY_HOURS = [0, 0, 0, 0, 0, 0, 0, 480, 1800, 2400, 2100, 1800, 600, 1440, 1200, 1140, 960, 1200, 0, 0, 0, 0, 0, 0];

  const DAY_WEIGHTS = [0, 0, 0, 0, 0, 0, 0, 0, 0.07, 0.12, 0.14, 0.12, 0.04, 0.1, 0.12, 0.11, 0.08, 0.07, 0.03, 0, 0, 0, 0, 0];

  function pad(n) { return String(n).padStart(2, '0'); }
  function keyOf(date) { return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`; }
  function at(date, hour, minute) { return new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, minute).toISOString(); }

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function random() {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function roundMinutes(seconds) { return Math.max(60, Math.round(seconds / 60) * 60); }

  function spreadHours(total, random, jitter = 0) {
    const hours = new Array(24).fill(0);
    const weights = DAY_WEIGHTS.map((w) => (w ? w * (1 + (random() - 0.5) * jitter) : 0));
    const sum = weights.reduce((a, b) => a + b, 0) || 1;
    const totalMinutes = Math.round(total / 60);
    const shares = weights.map((w) => ({ h: 0, raw: (totalMinutes * w) / sum }));
    shares.forEach((share, h) => { share.h = h; share.minutes = Math.floor(share.raw); });
    let left = totalMinutes - shares.reduce((acc, share) => acc + share.minutes, 0);
    const ordered = [...shares].filter((share) => share.raw > 0).sort((a, b) => (b.raw % 1) - (a.raw % 1));
    let idx = 0;
    while (left > 0 && ordered.length) {
      ordered[idx % ordered.length].minutes += 1;
      left--;
      idx++;
    }
    for (const share of shares) hours[share.h] = share.minutes * 60;
    return hours;
  }

  function buildDay(date, offset, random) {
    let apps;
    if (offset === 0) {
      apps = TODAY_APPS.map(([key, name, title, seconds]) => ({ key, name, title, seconds, browser: name === 'Google Chrome' ? 'Google Chrome' : null }));
    } else {
      const weekend = [0, 6].includes(date.getDay());
      const factor = (weekend ? 0.42 : 0.72) + random() * (weekend ? 0.24 : 0.42);
      apps = TODAY_APPS
        .map(([key, name, title, seconds]) => {
          const jitter = 0.55 + random() * 1.05;
          return { key, name, title, seconds: roundMinutes(seconds * factor * jitter), browser: name === 'Google Chrome' ? 'Google Chrome' : null };
        })
        .filter((app) => app.seconds >= 60);
    }

    const total = apps.reduce((sum, app) => sum + app.seconds, 0);
    const browserSeconds = apps.filter((app) => app.browser).reduce((sum, app) => sum + app.seconds, 0);

    const sites = [];
    if (browserSeconds > 0) {
      if (offset === 0) {
        for (const [domain, title, browser, seconds] of TODAY_SITES) {
          sites.push({ domain, title, browser, seconds: Math.min(seconds, browserSeconds) });
        }
      } else {
        const weights = TODAY_SITES.map(([, , , seconds]) => seconds * (0.55 + random() * 0.9));
        const weightSum = weights.reduce((a, b) => a + b, 0) || 1;
        const rows = TODAY_SITES.map(([domain, title, browser], i) => ({
          domain,
          title,
          browser,
          seconds: Math.round((browserSeconds * weights[i]) / weightSum / 60) * 60,
        }));
        const diff = browserSeconds - rows.reduce((sum, site) => sum + site.seconds, 0);
        let largest = 0;
        rows.forEach((row, i) => { if (row.seconds > rows[largest].seconds) largest = i; });
        rows[largest].seconds = Math.max(60, rows[largest].seconds + diff);
        for (const row of rows) if (row.seconds >= 60) sites.push(row);
      }
    }

    const hours = offset === 0 ? TODAY_HOURS.slice() : spreadHours(total, random, 0.3);

    const appMap = {};
    for (const app of apps) {
      appMap[app.key] = {
        name: app.name,
        seconds: app.seconds,
        title: app.title,
        browser: app.browser,
        lastAt: Date.parse(at(date, 17, 12)),
      };
    }
    const siteMap = {};
    for (const site of sites) {
      siteMap[site.domain] = { seconds: site.seconds, title: site.title, browser: site.browser, lastAt: Date.parse(at(date, 17, 10)) };
    }

    return {
      apps: appMap,
      sites: siteMap,
      hours,
      totalSeconds: total,
      browserSeconds,
      firstAt: at(date, 7, 5),
      lastAt: offset === 0 ? at(date, 18, 47) : at(date, 18, 2),
    };
  }

  function buildDays(count = 30, end = new Date()) {
    const days = {};
    for (let offset = 0; offset < count; offset++) {
      const date = new Date(end.getFullYear(), end.getMonth(), end.getDate() - offset, 12);
      const random = mulberry32(20261027 + offset * 7919);
      days[keyOf(date)] = buildDay(date, offset, random);
    }
    return days;
  }

  function aggregate(days, dayCount = 1, end = new Date()) {
    const out = { totalSeconds: 0, browserSeconds: 0, daysWithData: 0, apps: {}, sites: {}, hours: new Array(24).fill(0) };
    for (let i = dayCount - 1; i >= 0; i--) {
      const date = new Date(end.getFullYear(), end.getMonth(), end.getDate() - i, 12);
      const day = days[keyOf(date)];
      if (!day) continue;
      let dayTotal = 0;
      for (const [key, app] of Object.entries(day.apps)) {
        dayTotal += app.seconds;
        const row = (out.apps[key] ||= { key, name: app.name, seconds: 0, title: app.title, browser: app.browser, lastAt: 0 });
        row.seconds += app.seconds;
        row.title = app.title || row.title;
        row.lastAt = Math.max(row.lastAt, app.lastAt || 0);
      }
      out.totalSeconds += dayTotal;
      out.browserSeconds += day.browserSeconds || 0;
      if (dayTotal > 0) out.daysWithData += 1;
      for (const [domain, site] of Object.entries(day.sites)) {
        const row = (out.sites[domain] ||= { domain, seconds: 0, title: site.title, browser: site.browser, lastAt: 0 });
        row.seconds += site.seconds;
        row.title = site.title || row.title;
        row.lastAt = Math.max(row.lastAt, site.lastAt || 0);
      }
      for (let h = 0; h < 24; h++) out.hours[h] += day.hours[h] || 0;
    }
    out.apps = Object.values(out.apps).sort((a, b) => b.seconds - a.seconds);
    out.sites = Object.values(out.sites).sort((a, b) => b.seconds - a.seconds);
    return out;
  }

  return { buildDays, aggregate, keyOf, TODAY_APPS, TODAY_SITES, TODAY_HOURS };
});
