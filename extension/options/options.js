'use strict';
/* global TabAmp */

const {
  MIN_MAX_VOLUME,
  MAX_MAX_VOLUME,
  MAX_VOLUME_PRESETS,
  normalizeVolume,
  getSettings,
  saveSettings,
  getRules,
  saveRule,
  removeRules,
  t,
  localize,
} = TabAmp;

const SAVED_MESSAGE_MS = 2000;

const $ = (id) => document.getElementById(id);
const ui = {
  maxPresets: $('max-presets'),
  maxForm: $('max-form'),
  maxCustom: $('max-custom'),
  maxStatus: $('max-status'),
  rulesEmpty: $('rules-empty'),
  rulesTable: $('rules-table'),
  rules: $('rules'),
  rulesFooter: $('rules-footer'),
  removeAll: $('remove-all'),
  rowTemplate: $('rule-row'),
};

let maxVolume = TabAmp.DEFAULT_MAX_VOLUME;
let rules = [];
let statusTimer = 0;

init();

async function init() {
  localize();
  ui.maxCustom.min = MIN_MAX_VOLUME;
  ui.maxCustom.max = MAX_MAX_VOLUME;
  showRangeHint();
  bindEvents();
  await load();
  // Pick up changes made from the popup while this page is open.
  browser.storage.onChanged.addListener((_changes, area) => {
    if (area === 'local') load();
  });
}

async function load() {
  [{ maxVolume }, rules] = await Promise.all([getSettings(), getRules()]);
  renderMax();
  renderRules();
}

/* ---------- maximum volume ---------- */

function renderMax() {
  ui.maxPresets.replaceChildren(
    ...MAX_VOLUME_PRESETS.map((volume) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn flex-1 tabular-nums aria-pressed:bg-muted aria-pressed:font-semibold';
      button.dataset.variant = 'outline';
      button.dataset.volume = volume;
      button.textContent = `${volume}%`;
      button.setAttribute('aria-pressed', String(volume === maxVolume));
      return button;
    }),
  );
  if (document.activeElement !== ui.maxCustom) ui.maxCustom.value = maxVolume;
}

function showRangeHint() {
  ui.maxStatus.textContent = t('optionsMaxRange', [String(MIN_MAX_VOLUME), String(MAX_MAX_VOLUME)]);
}

async function setMaxVolume(volume) {
  await saveSettings({ maxVolume: volume });
  ui.maxCustom.removeAttribute('aria-invalid');
  ui.maxStatus.removeAttribute('data-invalid');
  ui.maxStatus.textContent = `✓ ${t('optionsSaved')}`;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(showRangeHint, SAVED_MESSAGE_MS);
}

/* ---------- site rules ---------- */

function createRow(site) {
  const row = ui.rowTemplate.content.firstElementChild.cloneNode(true);
  localize(row);
  row.dataset.site = site;

  const name = row.querySelector('[data-site]');
  name.textContent = site;
  name.title = site;

  const input = row.querySelector('[data-volume]');
  input.addEventListener('change', () => {
    if (input.value === '') renderRules();
    else saveRule(site, normalizeVolume(input.valueAsNumber, maxVolume));
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') input.blur();
  });
  input.addEventListener('blur', renderRules);

  row.querySelector('[data-remove]').addEventListener('click', () => removeRules([site]));
  return row;
}

function renderRules() {
  const empty = rules.length === 0;
  ui.rulesEmpty.hidden = !empty;
  ui.rulesTable.hidden = empty;
  ui.rulesFooter.hidden = empty;

  // Update rows in place so a focused volume input keeps its focus.
  const rows = new Map([...ui.rules.children].map((row) => [row.dataset.site, row]));
  rules.forEach((rule, index) => {
    const row = rows.get(rule.site) ?? createRow(rule.site);
    rows.delete(rule.site);
    const input = row.querySelector('[data-volume]');
    input.max = maxVolume;
    if (document.activeElement !== input) input.value = rule.volume;
    if (ui.rules.children[index] !== row) ui.rules.insertBefore(row, ui.rules.children[index] ?? null);
  });
  for (const row of rows.values()) row.remove();
}

/* ---------- events ---------- */

function bindEvents() {
  ui.maxPresets.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-volume]');
    if (button) setMaxVolume(Number(button.dataset.volume));
  });

  ui.maxForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const volume = ui.maxCustom.valueAsNumber;
    if (Number.isInteger(volume) && volume >= MIN_MAX_VOLUME && volume <= MAX_MAX_VOLUME) {
      setMaxVolume(volume);
      return;
    }
    ui.maxCustom.setAttribute('aria-invalid', 'true');
    ui.maxStatus.setAttribute('data-invalid', '');
    showRangeHint();
    ui.maxCustom.focus();
  });
  ui.maxCustom.addEventListener('input', () => {
    ui.maxCustom.removeAttribute('aria-invalid');
    ui.maxStatus.removeAttribute('data-invalid');
  });

  ui.removeAll.addEventListener('click', () => {
    if (confirm(t('optionsRemoveAllConfirm', String(rules.length)))) removeRules(rules.map((rule) => rule.site));
  });
}
