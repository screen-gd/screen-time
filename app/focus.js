(function () {
  'use strict';

  const site = new URLSearchParams(window.location.search).get('site') || '';
  document.getElementById('site').textContent = site;
  document.getElementById('open-app').addEventListener('click', () => {
    if (window.focusCover) window.focusCover.openApp();
  });
})();
