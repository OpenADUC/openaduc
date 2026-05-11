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
import './styles/main.css';

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

app.mount('#app');
