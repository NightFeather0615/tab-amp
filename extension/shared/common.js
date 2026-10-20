'use strict';

/**
 * Constants and helpers shared by the background script, the popup and the
 * options page. Loaded as a classic script, so `TabAmp` is a global.
 *
 * Storage layout
 *   storage.local    settings        { maxVolume }
 *                    rule:<site>     { volume, updatedAt }   remembered per-site volume
 *   storage.session  tab:<tabId>     { site, volume }        volume set for one tab
 */
const TabAmp = (() => {
  const DEFAULT_VOLUME = 100;
  const DEFAULT_MAX_VOLUME = 300;
  const MIN_MAX_VOLUME = 100;
  const MAX_MAX_VOLUME = 2000;
  const MAX_VOLUME_PRESETS = [200, 300, 500, 1000];
  const RULE_PREFIX = 'rule:';

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  function normalizeMaxVolume(value) {
    const n = Math.round(Number(value));
    return Number.isFinite(n) ? clamp(n, MIN_MAX_VOLUME, MAX_MAX_VOLUME) : DEFAULT_MAX_VOLUME;
  }

  function normalizeVolume(value, maxVolume) {
    const n = Math.round(Number(value));
    return Number.isFinite(n) ? clamp(n, 0, maxVolume) : DEFAULT_VOLUME;
  }

  /** The site a URL belongs to for site rules: its hostname without "www.", or '' for non-web pages. */
  function siteKey(url) {
    try {
      const { protocol, hostname } = new URL(url);
      if (protocol !== 'http:' && protocol !== 'https:') return '';
      return hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  }

  const ruleKey = (site) => RULE_PREFIX + site;

  async function getSettings() {
    const { settings } = await browser.storage.local.get('settings');
    return { maxVolume: normalizeMaxVolume(settings?.maxVolume ?? DEFAULT_MAX_VOLUME) };
  }

  function saveSettings(settings) {
    return browser.storage.local.set({ settings: { maxVolume: normalizeMaxVolume(settings.maxVolume) } });
  }

  /** All site rules, sorted by site. */
  async function getRules() {
    const all = await browser.storage.local.get(null);
    return Object.entries(all)
      .filter(([key, rule]) => key.startsWith(RULE_PREFIX) && Number.isFinite(rule?.volume))
      .map(([key, rule]) => ({ site: key.slice(RULE_PREFIX.length), volume: rule.volume }))
      .sort((a, b) => a.site.localeCompare(b.site));
  }

  function saveRule(site, volume) {
    return browser.storage.local.set({ [ruleKey(site)]: { volume, updatedAt: Date.now() } });
  }

  function removeRules(sites) {
    return browser.storage.local.remove(sites.map(ruleKey));
  }

  const t = (key, substitutions) => browser.i18n.getMessage(key, substitutions) || key;

  /** Fill in text marked with data-i18n, data-i18n-title, data-i18n-aria-label and data-i18n-placeholder. */
  function localize(root = document) {
    for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
    for (const attr of ['title', 'aria-label', 'placeholder']) {
      for (const el of root.querySelectorAll(`[data-i18n-${attr}]`)) {
        el.setAttribute(attr, t(el.getAttribute(`data-i18n-${attr}`)));
      }
    }
    document.documentElement.lang = browser.i18n.getUILanguage();
  }

  return {
    DEFAULT_VOLUME,
    DEFAULT_MAX_VOLUME,
    MIN_MAX_VOLUME,
    MAX_MAX_VOLUME,
    MAX_VOLUME_PRESETS,
    RULE_PREFIX,
    clamp,
    normalizeMaxVolume,
    normalizeVolume,
    siteKey,
    ruleKey,
    getSettings,
    saveSettings,
    getRules,
    saveRule,
    removeRules,
    t,
    localize,
  };
})();
