// SPDX-License-Identifier: BUSL-1.1
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import PrimeVue from 'primevue/config';
import ToastService from 'primevue/toastservice';
import Tooltip from 'primevue/tooltip';
import App from './App.vue';
import { router } from './router/index.js';
import { adManageTheme } from './design/theme.js';
import { useThemeStore } from './design/stores/useTheme.js';
import { setUnauthorizedHandler } from './api/client.js';
import { useAuthStore } from './stores/auth.js';
import './styles/main.css';
import './oldschool/oldschool.css';

const app = createApp(App);
app.use(createPinia());
app.use(router);
app.use(PrimeVue, {
  theme: {
    preset: adManageTheme,
    options: {
      darkModeSelector: '.theme-dark',
      cssLayer: false,
    },
  },
  pt: {
    // Password marks its input as a popup trigger for the strength meter
    // even with the meter off (:feedback="false" everywhere here); a plain
    // password field mustn't claim aria-expanded / aria-haspopup.
    password: {
      pcInputText: { root: { 'aria-expanded': null, 'aria-haspopup': null } },
    },
  },
});
app.use(ToastService);
app.directive('tooltip', Tooltip);

// Initialise the theme store before mount so the watchEffect runs on the
// pre-rendered shell and the body class is in sync with persisted state.
useThemeStore();

// The server session expired or was revoked: drop the signed-in state and
// send the operator to sign-in, then back to where they were. Several
// requests failing at once only redirect once.
setUnauthorizedHandler(() => {
  const auth = useAuthStore();
  if (!auth.isAuthenticated) return;
  auth.sessionEnded();
  const current = router.currentRoute.value;
  if (current.meta.public === true) return;
  void router.push({ name: 'login', query: { next: current.fullPath, expired: '1' } });
});

// A deploy replaces the hashed route chunks, so a tab still running the
// previous build can't load the next page: load that page from the server,
// which serves the new build. At most once a minute, in case a chunk is
// missing for some other reason.
let chunkLoadFailed = false;
window.addEventListener('vite:preloadError', () => {
  chunkLoadFailed = true;
});
router.onError((_err, to) => {
  if (!chunkLoadFailed) return;
  chunkLoadFailed = false;
  const key = 'openaduc:reloaded-for-new-build';
  if (Date.now() - Number(sessionStorage.getItem(key) ?? 0) < 60_000) return;
  sessionStorage.setItem(key, String(Date.now()));
  window.location.assign(to.fullPath);
});

app.mount('#app');
