(() => {
  const storageKey = 'agent-relay-theme';
  const root = document.documentElement;
  try { root.dataset.theme = localStorage.getItem(storageKey) === 'light' ? 'light' : 'dark'; }
  catch { root.dataset.theme = 'dark'; }

  function updateButtons() {
    const light = root.dataset.theme === 'light';
    for (const button of document.querySelectorAll('[data-theme-toggle]')) {
      button.textContent = light ? '☾ 深色' : '☼ 浅色';
      button.setAttribute('aria-label', light ? '切换深色模式' : '切换浅色模式');
      button.setAttribute('aria-pressed', String(light));
    }
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', light ? '#ffffff' : '#0d1117');
  }

  document.addEventListener('DOMContentLoaded', () => {
    updateButtons();
    document.addEventListener('click', event => {
      if (!event.target.closest('[data-theme-toggle]')) return;
      root.dataset.theme = root.dataset.theme === 'light' ? 'dark' : 'light';
      try { localStorage.setItem(storageKey, root.dataset.theme); } catch {}
      updateButtons();
    });
  });
})();
