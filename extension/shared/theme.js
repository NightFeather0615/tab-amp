'use strict';

// Basecoat switches to its dark palette with `html.dark`; follow the system setting.
(() => {
  const query = matchMedia('(prefers-color-scheme: dark)');
  const apply = () => document.documentElement.classList.toggle('dark', query.matches);
  apply();
  query.addEventListener('change', apply);
})();
