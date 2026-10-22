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

app.mount('#app');
