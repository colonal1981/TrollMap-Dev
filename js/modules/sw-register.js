/**
 * Service Worker registration — registers ./sw.js once the page
 * has finished loading. Logs success/failure to the console.
 */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').then((reg) => {
      console.log('✓ PWA Service Worker successfully registered:', reg.scope);
    }).catch((err) => console.warn('PWA Service Worker registration failed:', err));
  });
}
