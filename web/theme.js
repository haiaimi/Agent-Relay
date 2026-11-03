(() => {
  const storageKey = 'agent-relay-theme';
  const root = document.documentElement;
  const system = matchMedia('(prefers-color-scheme: dark)');
  const modes = ['system', 'light', 'dark'];
  const names = {system: '跟随系统', light: '浅色', dark: '深色'};
  let mode = 'system';
  try { const saved = localStorage.getItem(storageKey); if (modes.includes(saved)) mode = saved; } catch {}

  function apply() {
    root.dataset.themeMode = mode;
    root.dataset.theme = mode === 'system' ? (system.matches ? 'dark' : 'light') : mode;
    updateButtons();
  }

  function updateButtons() {
    const light = root.dataset.theme === 'light';
    for (const button of document.querySelectorAll('[data-theme-toggle]')) {
      const next = modes[(modes.indexOf(mode) + 1) % modes.length];
      button.textContent = (mode === 'system' ? '◐ ' : light ? '☼ ' : '☾ ') + names[mode];
      button.dataset.themeMode = mode;
      button.setAttribute('aria-label', '外观：' + names[mode] + '，切换为' + names[next]);
      button.setAttribute('title', '外观：' + names[mode] + '，切换为' + names[next]);
    }
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', light ? '#ffffff' : '#0d1117');
  }
  apply();
  system.addEventListener('change', () => { if (mode === 'system') apply(); });

  document.addEventListener('DOMContentLoaded', () => {
    updateButtons();
    document.addEventListener('click', event => {
      if (!event.target.closest('[data-theme-toggle]')) return;
      mode = modes[(modes.indexOf(mode) + 1) % modes.length];
      try { localStorage.setItem(storageKey, mode); } catch {}
      apply();
    });
  });
})();
