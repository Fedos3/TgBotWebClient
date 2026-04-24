import type { GlobalState } from '../global/types';

import {
  GLOBAL_STATE_CACHE_PREFIX,
  IS_BOT_PANEL,
  IS_SCREEN_LOCKED_CACHE_KEY,
  IS_MOCKED_CLIENT,
  MULTITAB_LOCALSTORAGE_KEY_PREFIX,
  SESSION_ACCOUNT_PREFIX,
  SESSION_LEGACY_USER_KEY,
} from '../config';
import {
  loadCache, loadCachedSharedState, removeGlobalFromCache, removeSharedStateFromCache,
} from '../global/cache';
import {
  getGlobal, setGlobal,
} from '../global/index';
import { INITIAL_GLOBAL_STATE } from '../global/initialState';
import { updatePasscodeSettings } from '../global/reducers';
import { MAIN_IDB_STORE, PASSCODE_IDB_STORE } from './browser/idb';
import { cloneDeep } from './iteratees';
import { clearStoredSession } from './sessions';

const BOT_PANEL_RUNTIME_RESET_KEY = 'tt-bot-panel-runtime-reset';

export async function prepareBotPanelRuntime() {
  if (!IS_BOT_PANEL || typeof window === 'undefined') {
    return false;
  }

  let shouldReload = false;

  try {
    if ('serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      if (registrations.length) {
        await Promise.all(registrations.map((registration) => registration.unregister()));
        shouldReload = true;
      }
    }
  } catch {
    // Ignore runtime cleanup failures and keep booting.
  }

  try {
    if ('caches' in window) {
      const cacheKeys = await caches.keys();
      const telegramCacheKeys = cacheKeys.filter((key) => key.startsWith('tt-'));
      if (telegramCacheKeys.length) {
        await Promise.all(telegramCacheKeys.map((key) => caches.delete(key)));
        shouldReload = true;
      }
    }
  } catch {
    // Ignore cache storage cleanup failures and keep booting.
  }

  try {
    const localStorageKeys = Object.keys(localStorage).filter((key) => (
      key === IS_SCREEN_LOCKED_CACHE_KEY
      || key === SESSION_LEGACY_USER_KEY
      || key.startsWith(GLOBAL_STATE_CACHE_PREFIX)
      || key.startsWith(MULTITAB_LOCALSTORAGE_KEY_PREFIX)
      || key.startsWith(SESSION_ACCOUNT_PREFIX)
    ));

    if (localStorageKeys.length) {
      localStorageKeys.forEach((key) => localStorage.removeItem(key));
      shouldReload = true;
    }
  } catch {
    // Ignore localStorage cleanup failures and keep booting.
  }

  try {
    const [mainKeys, passcodeKeys] = await Promise.all([
      MAIN_IDB_STORE.keys(),
      PASSCODE_IDB_STORE.keys(),
    ]);

    if (mainKeys.length || passcodeKeys.length) {
      await Promise.all([
        removeGlobalFromCache(),
        removeSharedStateFromCache(),
        MAIN_IDB_STORE.clear(),
        PASSCODE_IDB_STORE.clear(),
      ]);
      shouldReload = true;
    }
  } catch {
    // Ignore IndexedDB cleanup failures and keep booting.
  }

  if (!shouldReload) {
    sessionStorage.removeItem(BOT_PANEL_RUNTIME_RESET_KEY);
    return false;
  }

  if (sessionStorage.getItem(BOT_PANEL_RUNTIME_RESET_KEY) === '1') {
    sessionStorage.removeItem(BOT_PANEL_RUNTIME_RESET_KEY);
    return false;
  }

  sessionStorage.setItem(BOT_PANEL_RUNTIME_RESET_KEY, '1');
  window.location.reload();
  return true;
}

export async function initGlobal(force: boolean = false, prevGlobal?: GlobalState) {
  prevGlobal = prevGlobal || getGlobal();
  if (!force && 'byTabId' in prevGlobal) {
    return;
  }

  const initial = cloneDeep(INITIAL_GLOBAL_STATE);
  const cache = await loadCache(initial);
  let global = cache || initial;
  if (IS_MOCKED_CLIENT || IS_BOT_PANEL) global.auth.state = 'authorizationStateReady';

  const { hasPasscode, isScreenLocked } = global.passcode;
  if (hasPasscode && !isScreenLocked) {
    global = updatePasscodeSettings(global, {
      isScreenLocked: true,
    });

    clearStoredSession();
  }

  if (force) {
    global.byTabId = prevGlobal.byTabId;
  }

  if (!cache) { // Try loading shared state separately
    const storedSharedState = await loadCachedSharedState();
    if (storedSharedState) {
      global.sharedState = storedSharedState;
    }
  }

  setGlobal(global);
}
