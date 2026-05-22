/**
 * Mobile-only UI (viewport ≤768px). Desktop behavior is unchanged.
 */
const MQ = '(max-width: 768px)';
const mql = window.matchMedia(MQ);

let scrim = null;
let bound = false;

function appEl() {
  return document.querySelector('.app');
}

function panelOpen(side) {
  const app = appEl();
  if (!app) return false;
  return !app.classList.contains(`${side}-collapsed`);
}

function updateScrim() {
  const app = appEl();
  if (!app || !scrim) return;
  const open = panelOpen('left') || panelOpen('right');
  app.classList.toggle('mobile-scrim-visible', open);
}

function onScrimClick() {
  if (!mql.matches) return;
  ['left', 'right'].forEach((side) => {
    if (panelOpen(side)) document.getElementById(`btn-panel-${side}`)?.click();
  });
}

function bindMobile() {
  if (bound || !mql.matches) return;
  const app = appEl();
  if (!app) return;

  if (!scrim) {
    scrim = document.createElement('div');
    scrim.className = 'mobile-scrim';
    scrim.setAttribute('aria-hidden', 'true');
    scrim.addEventListener('click', onScrimClick);
    app.prepend(scrim);
  }

  const observer = new MutationObserver(updateScrim);
  observer.observe(app, { attributes: true, attributeFilter: ['class'] });
  updateScrim();
  bound = true;
}

function unbindMobile() {
  const app = appEl();
  app?.classList.remove('mobile-scrim-visible');
  scrim?.remove();
  scrim = null;
  bound = false;
}

function onMqChange(e) {
  if (e.matches) bindMobile();
  else unbindMobile();
}

function whenAppReady(fn) {
  if (appEl()) {
    fn();
    return;
  }
  const obs = new MutationObserver(() => {
    if (appEl()) {
      obs.disconnect();
      fn();
    }
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });
}

function waitForAppInit(cb) {
  let n = 0;
  const tick = () => {
    const ready =
      document.querySelector('.canvas-wrap')?.clientWidth > 0 &&
      document.getElementById('catalog-list')?.childElementCount > 0;
    if (ready) {
      cb();
      return;
    }
    if (++n < 240) requestAnimationFrame(tick);
  };
  tick();
}

whenAppReady(() => {
  waitForAppInit(() => {
    if (mql.matches) bindMobile();
  });
  mql.addEventListener('change', onMqChange);
});
