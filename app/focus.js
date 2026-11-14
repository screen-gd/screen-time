(function () {
  'use strict';

  // The guard passes what it judged as query params: kind/label/mode always,
  // goal and endsAt while a session runs. Copy follows session, mode and kind.
  const params = new URLSearchParams(window.location.search);
  const kind = params.get('kind') || 'site';
  const label = params.get('label') || '';
  const mode = params.get('mode') || 'block';
  const goal = params.get('goal') || '';
  const endsAt = params.get('endsAt') || '';

  document.getElementById('heading').textContent = goal || 'Block list is on';
  document.getElementById('verdict').textContent = !goal
    ? `${label} is on your block list.`
    : kind === 'page'
      ? "This page isn't on the list for this session."
      : mode === 'allow' && kind === 'app'
        ? `${label} isn't part of this session.`
        : mode === 'allow'
          ? `${label} isn't on the list for this session.`
          : `${label} is blocked during this session.`;
  document.getElementById('why').textContent = mode === 'allow'
    ? 'Switch to something on the list and this screen goes away.'
    : 'Close it or switch to something else and this screen goes away.';

  const left = document.getElementById('left');
  function tick() {
    const ms = Date.parse(endsAt) - Date.now();
    if (!endsAt || Number.isNaN(ms)) {
      left.textContent = '';
      return;
    }
    left.textContent = `${Math.max(0, Math.ceil(ms / 60000))} min left`;
  }
  tick();
  setInterval(tick, 15000);

  document.getElementById('open-app').addEventListener('click', () => {
    if (window.focusCover) window.focusCover.openApp();
  });
})();
