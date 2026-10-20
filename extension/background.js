'use strict';
/* global TabAmp */

/*
 * Source of truth for which volume each tab plays at.
 *
 * A tab's volume comes from, in order:
 *   1. the volume set for that tab in the popup, while the tab stays on the same site;
 *   2. the site rule ("remember for this site"), if one exists;
 *   3. 100%.
 * Content scripts ask for their volume when a page loads and get pushed updates.
 */

const { DEFAULT_VOLUME, RULE_PREFIX, siteKey, ruleKey, normalizeVolume, normalizeMaxVolume, getSettings, saveRule } =
  TabAmp;

const TAB_PREFIX = 'tab:';
const BADGE_BOOSTED = '#ea580c';
const BADGE_REDUCED = '#52525b';

browser.action.setBadgeTextColor({ color: '#ffffff' });

/* ---------- state ---------- */

const tabKey = (tabId) => TAB_PREFIX + tabId;

async function getTabState(tabId) {
  const key = tabKey(tabId);
  return (await browser.storage.session.get(key))[key] ?? null;
}

function setTabState(tabId, state) {
  return browser.storage.session.set({ [tabKey(tabId)]: state });
}

function clearTabState(tabId) {
  return browser.storage.session.remove(tabKey(tabId));
}

async function getRuleVolume(site) {
  if (!site) return null;
  const key = ruleKey(site);
  const rule = (await browser.storage.local.get(key))[key];
  return Number.isFinite(rule?.volume) ? rule.volume : null;
}

/** The volume a page at `url` should play at in this tab. */
async function resolveVolume(tabId, url) {
  const site = siteKey(url);
  const [state, { maxVolume }] = await Promise.all([getTabState(tabId), getSettings()]);
  if (state && state.site === site) return normalizeVolume(state.volume, maxVolume);
  // The tab moved to another site; its per-tab volume doesn't follow it there.
  if (state) await clearTabState(tabId);
  return normalizeVolume((await getRuleVolume(site)) ?? DEFAULT_VOLUME, maxVolume);
}

// Changes run one at a time so rapid slider events can't land out of order.
let queue = Promise.resolve();
function serialized(task) {
  const run = queue.then(task);
  queue = run.catch(() => {});
  return run;
}

/* ---------- effects ---------- */

async function pushVolume(tabId, volume) {
  try {
    // Without a frameId this reaches the content script in every frame of the tab.
    await browser.tabs.sendMessage(tabId, { type: 'tabamp:apply', volume });
  } catch {
    // No content script in this tab (e.g. about: pages).
  }
}

async function updateBadge(tabId, volume) {
  try {
    await Promise.all([
      browser.action.setBadgeText({ tabId, text: volume === DEFAULT_VOLUME ? '' : String(volume) }),
      browser.action.setBadgeBackgroundColor({ tabId, color: volume > DEFAULT_VOLUME ? BADGE_BOOSTED : BADGE_REDUCED }),
    ]);
  } catch {
    // The tab is gone.
  }
}

/* ---------- content scripts ---------- */

async function handleHello(sender) {
  const tab = sender.tab;
  if (!tab) return null;
  const isTopFrame = sender.frameId === 0;
  // Frames follow the volume of the page they're embedded in.
  const volume = await resolveVolume(tab.id, isTopFrame ? (sender.url ?? tab.url) : tab.url);
  // Firefox clears tab-specific badges on navigation, so each new page sets it again.
  if (isTopFrame) await updateBadge(tab.id, volume);
  return { volume };
}

/** Media stats from every frame of the tab, or null if the extension can't run there. */
async function probeTab(tabId) {
  const collect = async () => {
    const results = await browser.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => globalThis.__tabAmp?.stats() ?? null,
    });
    // Frames the extension can't access come back as empty entries rather than an error.
    return (results ?? []).filter(Boolean);
  };
  const hasTopFrame = (results) => Boolean(results.find((r) => r.frameId === 0)?.result);

  let results;
  try {
    results = await collect();
    if (!hasTopFrame(results)) {
      // No content script yet, e.g. the tab was already open when the add-on was installed.
      await browser.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content.js'] });
      results = await collect();
    }
  } catch {
    return null;
  }
  if (!hasTopFrame(results)) return null;

  const frames = results.map((r) => r.result).filter(Boolean);
  const sum = (field) => frames.reduce((total, frame) => total + (frame[field] ?? 0), 0);
  return {
    total: sum('total'),
    playing: sum('playing'),
    limited: sum('limited'),
    waiting: sum('waiting'),
  };
}

async function hasHostAccess(url) {
  try {
    const { protocol, origin } = new URL(url);
    if (protocol !== 'http:' && protocol !== 'https:') return true;
    return await browser.permissions.contains({ origins: [`${origin}/*`] });
  } catch {
    return true;
  }
}

/* ---------- popup ---------- */

async function getTabInfo(tabId) {
  const tab = await browser.tabs.get(tabId);
  const media = await probeTab(tabId);
  let access = 'ok';
  if (!media) access = (await hasHostAccess(tab.url)) ? 'restricted' : 'denied';
  return { access, media, audible: Boolean(tab.audible), muted: Boolean(tab.mutedInfo?.muted) };
}

async function getPopupState(tabId) {
  const tab = await browser.tabs.get(tabId);
  const site = siteKey(tab.url);
  const [volume, ruleVolume, { maxVolume }, info] = await Promise.all([
    resolveVolume(tabId, tab.url),
    getRuleVolume(site),
    getSettings(),
    getTabInfo(tabId),
  ]);
  return { site, title: tab.title ?? '', volume, ruleVolume, maxVolume, ...info };
}

async function setTabVolume(tabId, volume, commit) {
  const tab = await browser.tabs.get(tabId);
  const site = siteKey(tab.url);
  const { maxVolume } = await getSettings();
  volume = normalizeVolume(volume, maxVolume);

  await Promise.all([setTabState(tabId, { site, volume }), pushVolume(tabId, volume), updateBadge(tabId, volume)]);
  // While the site rule is on, it follows the tab. Only written once the user lets go of the slider.
  if (commit && (await getRuleVolume(site)) !== null) await saveRule(site, volume);
  return { volume };
}

async function setSiteRule(tabId, enabled) {
  const tab = await browser.tabs.get(tabId);
  const site = siteKey(tab.url);
  if (!site) throw new Error('This page has no site to remember.');
  if (enabled) await saveRule(site, await resolveVolume(tabId, tab.url));
  else await browser.storage.local.remove(ruleKey(site));
  return { ruleVolume: await getRuleVolume(site) };
}

/* ---------- settings ---------- */

/** Bring stored and playing volumes back under a lowered maximum. */
async function applyMaxVolume(maxVolume) {
  const rules = await browser.storage.local.get(null);
  const clampedRules = {};
  for (const [key, rule] of Object.entries(rules)) {
    if (key.startsWith(RULE_PREFIX) && rule?.volume > maxVolume) clampedRules[key] = { ...rule, volume: maxVolume };
  }
  if (Object.keys(clampedRules).length) await browser.storage.local.set(clampedRules);

  const states = await browser.storage.session.get(null);
  for (const [key, state] of Object.entries(states)) {
    if (key.startsWith(TAB_PREFIX) && state?.volume > maxVolume) {
      await setTabState(Number(key.slice(TAB_PREFIX.length)), { ...state, volume: maxVolume });
    }
  }

  const tabs = await browser.tabs.query({});
  await Promise.all(
    tabs.map(async (tab) => {
      const volume = await resolveVolume(tab.id, tab.url);
      if (volume === maxVolume) await Promise.all([pushVolume(tab.id, volume), updateBadge(tab.id, volume)]);
    }),
  );
}

/* ---------- listeners ---------- */

browser.runtime.onMessage.addListener((message, sender) => {
  switch (message?.type) {
    case 'content:hello':
      return handleHello(sender);
    case 'popup:state':
      return getPopupState(message.tabId);
    case 'popup:tab-info':
      return getTabInfo(message.tabId);
    case 'popup:set-volume':
      return serialized(() => setTabVolume(message.tabId, message.volume, message.commit));
    case 'popup:set-rule':
      return serialized(() => setSiteRule(message.tabId, message.enabled));
    default:
      return undefined;
  }
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  const before = normalizeMaxVolume(changes.settings.oldValue?.maxVolume ?? TabAmp.DEFAULT_MAX_VOLUME);
  const after = normalizeMaxVolume(changes.settings.newValue?.maxVolume ?? TabAmp.DEFAULT_MAX_VOLUME);
  if (after < before) serialized(() => applyMaxVolume(after));
});

browser.tabs.onRemoved.addListener((tabId) => {
  clearTabState(tabId);
});
