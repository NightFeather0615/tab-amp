'use strict';
/* global TabAmp */

const { DEFAULT_VOLUME, MAX_VOLUME_PRESETS, normalizeVolume, saveSettings, t, localize } = TabAmp;

const STEP = 10; // −/+ buttons
const WHEEL_STEP = 5;
const POLL_MS = 1000;

const $ = (id) => document.getElementById(id);
const ui = {
  site: $('site'),
  playing: $('playing'),
  openOptions: $('open-options'),
  unavailable: $('unavailable'),
  unavailableTitle: $('unavailable-title'),
  unavailableDesc: $('unavailable-desc'),
  unavailableActions: $('unavailable-actions'),
  grant: $('grant'),
  controls: $('controls'),
  value: $('volume-value'),
  hint: $('volume-hint'),
  decrease: $('decrease'),
  input: $('volume-input'),
  increase: $('increase'),
  mute: $('mute'),
  slider: $('slider'),
  markMin: $('mark-min'),
  markDefault: $('mark-default'),
  markMax: $('mark-max'),
  presets: $('presets'),
  noMedia: $('no-media'),
  siteRule: $('site-rule'),
  siteRuleDesc: $('site-rule-desc'),
  alerts: $('alerts'),
  alertTemplate: $('alert-template'),
  maxSelect: $('max-volume'),
  reset: $('reset'),
};

let tabId = null;
/** Popup state from the background, updated locally as the user changes things. */
let state = null;
/** What to go back to when unmuting with the speaker button. */
let lastAudibleVolume = DEFAULT_VOLUME;
let alertsKey = '';

init();

async function init() {
  localize();
  bindEvents();
  // ?tabId= lets the popup be opened in a tab to control another one (handy for debugging).
  const requested = Number(new URLSearchParams(location.search).get('tabId'));
  if (Number.isInteger(requested) && requested > 0) tabId = requested;
  else [{ id: tabId } = {}] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tabId == null) return showUnavailable('restricted');

  await refresh();
  ui.slider.focus();
  setInterval(refreshTabInfo, POLL_MS);
}

async function refresh() {
  state = await browser.runtime.sendMessage({ type: 'popup:state', tabId });
  if (state.volume > 0) lastAudibleVolume = state.volume;
  render();
}

async function refreshTabInfo() {
  if (!state) return;
  try {
    const info = await browser.runtime.sendMessage({ type: 'popup:tab-info', tabId });
    if (info.access !== state.access) return refresh();
    Object.assign(state, info);
    renderTabInfo();
  } catch {
    // The tab was closed; nothing left to show.
  }
}

/* ---------- rendering ---------- */

function render() {
  ui.site.textContent = state.site || state.title || '';
  ui.site.title = ui.site.textContent;
  if (state.access !== 'ok') return showUnavailable(state.access);
  ui.unavailable.hidden = true;
  ui.controls.hidden = false;
  renderScale();
  renderVolume();
  renderTabInfo();
}

function showUnavailable(access) {
  const denied = access === 'denied';
  ui.controls.hidden = true;
  ui.unavailable.hidden = false;
  ui.unavailableTitle.textContent = t(denied ? 'deniedTitle' : 'unavailableTitle');
  ui.unavailableDesc.textContent = t(denied ? 'deniedDesc' : 'unavailableDesc');
  ui.unavailableActions.hidden = !denied;
}

/** Quick-pick volumes for a given maximum: 50%, 100%, two steps in between, and the maximum. */
function presetsFor(max) {
  if (max <= DEFAULT_VOLUME) return [25, 50, 75, 100].filter((v) => v < max).concat(max);
  const steps = [150, 200, 300, 400, 500, 600, 800, 1000, 1500].filter((v) => v < max);
  const picks =
    steps.length <= 2
      ? steps
      : [steps[Math.round((steps.length - 1) / 3)], steps[Math.round((2 * (steps.length - 1)) / 3)]];
  return [50, DEFAULT_VOLUME, ...picks, max];
}

function renderScale() {
  const max = state.maxVolume;
  ui.slider.max = max;
  ui.input.max = max;
  ui.markMax.textContent = `${max}%`;

  // Line the 100% mark up with the thumb's center (the thumb is 1rem wide).
  // It matters more than the end labels, so those give way when they'd overlap.
  const position = DEFAULT_VOLUME / max;
  ui.markDefault.style.left = `calc(0.5rem + (100% - 1rem) * ${position})`;
  ui.markDefault.hidden = position > 0.85;
  ui.markMin.hidden = position < 0.15;

  ui.presets.replaceChildren(
    ...presetsFor(max).map((volume) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn flex-1 px-1 tabular-nums aria-pressed:bg-muted aria-pressed:font-semibold';
      button.dataset.variant = 'outline';
      button.dataset.size = 'sm';
      button.dataset.volume = volume;
      button.textContent = `${volume}%`;
      return button;
    }),
  );

  const choices = [...new Set([...MAX_VOLUME_PRESETS, max])].sort((a, b) => a - b);
  ui.maxSelect.replaceChildren(...choices.map((v) => new Option(`${v}%`, v, false, v === max)));
}

const formatFactor = (volume) =>
  (volume / 100).toLocaleString(browser.i18n.getUILanguage(), { maximumFractionDigits: 2 });

function renderVolume() {
  const { volume, maxVolume, site, ruleVolume } = state;

  ui.slider.value = volume;
  ui.slider.style.setProperty('--slider-value', `${(volume / maxVolume) * 100}%`);
  ui.value.textContent = volume;
  if (document.activeElement !== ui.input) ui.input.value = volume;

  if (volume === 0) ui.hint.textContent = t('hintMuted');
  else if (volume < DEFAULT_VOLUME) ui.hint.textContent = t('hintReduced');
  else if (volume === DEFAULT_VOLUME) ui.hint.textContent = t('hintOriginal');
  else ui.hint.textContent = t('hintBoosted', formatFactor(volume));
  ui.hint.toggleAttribute('data-boosted', volume > DEFAULT_VOLUME);

  const level = volume === 0 ? 'muted' : volume < DEFAULT_VOLUME ? 'low' : 'high';
  for (const part of ui.mute.querySelectorAll('[data-icon]')) {
    const shown = part.dataset.icon === 'muted' ? level === 'muted' : part.dataset.icon === 'low' ? level !== 'muted' : level === 'high';
    part.toggleAttribute('hidden', !shown);
  }
  const muteLabel = t(volume === 0 ? 'unmute' : 'mute');
  ui.mute.title = muteLabel;
  ui.mute.setAttribute('aria-label', muteLabel);

  for (const button of ui.presets.children) {
    button.setAttribute('aria-pressed', String(Number(button.dataset.volume) === volume));
  }

  ui.siteRule.disabled = !site;
  ui.siteRule.checked = Boolean(site) && ruleVolume !== null;
  if (!site) ui.siteRuleDesc.textContent = t('siteRuleUnavailable');
  else if (ruleVolume === null) ui.siteRuleDesc.textContent = t('siteRuleOff', site);
  else ui.siteRuleDesc.textContent = t('siteRuleOn', [site, String(ruleVolume)]);

  renderAlerts();
}

function renderTabInfo() {
  ui.playing.hidden = !state.audible;
  ui.noMedia.hidden = !state.media || state.media.total > 0;
  renderAlerts();
}

function renderAlerts() {
  const alerts = [];
  if (state.muted) alerts.push({ key: 'warnTabMuted', action: unmuteTab });
  if (state.volume !== DEFAULT_VOLUME && state.media?.waiting > 0) alerts.push({ key: 'warnGesture' });
  if (state.volume > DEFAULT_VOLUME && state.media?.limited > 0) alerts.push({ key: 'warnLimited' });

  const key = alerts.map((a) => a.key).join();
  if (key === alertsKey) return;
  alertsKey = key;

  ui.alerts.replaceChildren(
    ...alerts.map(({ key, action }) => {
      const alert = ui.alertTemplate.content.firstElementChild.cloneNode(true);
      alert.querySelector('h2').textContent = t(`${key}Title`);
      alert.querySelector('p').textContent = t(`${key}Desc`);
      if (action) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn mt-2 justify-self-start';
        button.dataset.variant = 'outline';
        button.dataset.size = 'xs';
        button.textContent = t(`${key}Action`);
        button.addEventListener('click', action);
        alert.querySelector('section').append(button);
      }
      return alert;
    }),
  );
}

/* ---------- actions ---------- */

function setVolume(value, commit) {
  const volume = normalizeVolume(value, state.maxVolume);
  if (volume > 0) lastAudibleVolume = volume;
  state.volume = volume;
  // While the site rule is on, the background updates it on commit; mirror that here.
  if (commit && state.ruleVolume !== null) state.ruleVolume = volume;
  renderVolume();
  browser.runtime.sendMessage({ type: 'popup:set-volume', tabId, volume, commit }).catch(() => {});
}

async function setSiteRule(enabled) {
  try {
    const { ruleVolume } = await browser.runtime.sendMessage({ type: 'popup:set-rule', tabId, enabled });
    state.ruleVolume = ruleVolume;
  } catch {
    // Leave the switch as it was.
  }
  renderVolume();
}

async function setMaxVolume(maxVolume) {
  await saveSettings({ maxVolume });
  // The background clamps stored volumes and the tab itself when the maximum drops.
  state.maxVolume = maxVolume;
  state.volume = Math.min(state.volume, maxVolume);
  if (state.ruleVolume !== null) state.ruleVolume = Math.min(state.ruleVolume, maxVolume);
  renderScale();
  renderVolume();
}

async function unmuteTab() {
  await browser.tabs.update(tabId, { muted: false });
  state.muted = false;
  renderAlerts();
}

function bindEvents() {
  ui.slider.addEventListener('input', () => setVolume(ui.slider.valueAsNumber, false));
  ui.slider.addEventListener('change', () => setVolume(ui.slider.valueAsNumber, true));
  ui.slider.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      setVolume(state.volume + (event.deltaY < 0 ? WHEEL_STEP : -WHEEL_STEP), true);
    },
    { passive: false },
  );

  ui.input.addEventListener('change', () => {
    if (ui.input.value === '') renderVolume();
    else setVolume(ui.input.valueAsNumber, true);
  });
  ui.input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') ui.input.blur();
  });
  ui.input.addEventListener('blur', renderVolume);

  ui.decrease.addEventListener('click', () => setVolume(Math.ceil(state.volume / STEP) * STEP - STEP, true));
  ui.increase.addEventListener('click', () => setVolume(Math.floor(state.volume / STEP) * STEP + STEP, true));
  ui.mute.addEventListener('click', () => setVolume(state.volume > 0 ? 0 : lastAudibleVolume, true));
  ui.reset.addEventListener('click', () => setVolume(DEFAULT_VOLUME, true));
  ui.presets.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-volume]');
    if (button) setVolume(Number(button.dataset.volume), true);
  });

  ui.siteRule.addEventListener('change', () => setSiteRule(ui.siteRule.checked));
  ui.maxSelect.addEventListener('change', () => setMaxVolume(Number(ui.maxSelect.value)));

  ui.openOptions.addEventListener('click', () => {
    browser.runtime.openOptionsPage();
    window.close();
  });
  ui.grant.addEventListener('click', () => {
    // Firefox only shows the prompt when this runs directly in the click handler.
    browser.permissions.request({ origins: ['<all_urls>'] }).then((granted) => granted && refresh());
  });
}
