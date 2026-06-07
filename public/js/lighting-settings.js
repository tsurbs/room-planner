/**
 * Persisted lighting preferences (localStorage).
 * Currently just the hardware-acceleration toggle exposed in the "more" menu.
 */

const STORAGE_KEY = 'room-planner-lighting-settings';

/** @typedef {{ lightingHardwareAccel: boolean }} LightingSettings */

/** @type {LightingSettings} */
const DEFAULTS = {
  lightingHardwareAccel: true,
};

/** @returns {LightingSettings} */
export function loadLightingSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw);
    return { ...DEFAULTS, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

/**
 * Merge a partial settings object and persist it.
 * @param {Partial<LightingSettings>} partial
 * @returns {LightingSettings}
 */
export function saveLightingSettings(partial) {
  const next = { ...loadLightingSettings(), ...partial };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable (private mode, quota) — keep in-memory only */
  }
  return next;
}

/** @returns {boolean} */
export function isLightingHardwareAccelEnabled() {
  return loadLightingSettings().lightingHardwareAccel !== false;
}
