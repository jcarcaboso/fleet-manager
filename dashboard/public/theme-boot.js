/* Applies a stored Light (or System on a light system) theme before the first paint, so a returning visitor does not see the dark
   default flash first. It is a classic script in <head>, from the dashboard's own origin as the CSP requires, and reads nothing but
   the theme preference. src/theme.ts takes over once the application starts; keep the key and the values in step with it. */
(function () {
  try {
    var stored = window.localStorage.getItem('fleet-theme');
    var light = stored === 'light' || (stored === 'system' && window.matchMedia('(prefers-color-scheme: light)').matches);
    if (light) document.documentElement.dataset.theme = 'light';
  } catch (e) {
    /* Blocked storage: the page stays dark until the application starts. */
  }
})();
