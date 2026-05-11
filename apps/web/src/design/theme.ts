// SPDX-License-Identifier: BUSL-1.1
// PrimeVue Aura preset override — keeps PrimeVue components in sync with our
// CSS-variable tokens. The colors below mirror tokens.css; PrimeVue resolves
// them at runtime so theme/density/accent changes apply to PrimeVue widgets
// (DataTable, Dialog, Select, DatePicker, etc) automatically.

import { definePreset } from '@primevue/themes';
import Aura from '@primevue/themes/aura';

export const adManageTheme = definePreset(Aura, {
  semantic: {
    primary: {
      50: '#ecfeff',
      100: '#cffafe',
      200: '#a5f3fc',
      300: '#67e8f9',
      400: '#22d3ee',
      500: '#06b6d4',
      600: '#0891b2',
      700: '#0e7490',
      800: '#155e75',
      900: '#164e63',
      950: '#083344',
    },
    colorScheme: {
      dark: {
        surface: {
          0: '#ffffff',
          50: '#fafafa',
          100: '#f4f4f5',
          200: '#e4e4e7',
          300: '#d4d4d8',
          400: '#a1a1aa',
          500: '#71717a',
          600: '#52525b',
          700: '#3f3f46',
          800: '#27272a',
          900: '#18181b',
          950: '#09090b',
        },
        primary: {
          color: '{primary.400}',
          contrastColor: '#07080a',
          hoverColor: '{primary.300}',
          activeColor: '{primary.500}',
        },
        formField: {
          background: '#18181b',
          disabledBackground: '#0c0c0e',
          filledBackground: '#1f1f23',
          filledHoverBackground: '#27272a',
          filledFocusBackground: '#1f1f23',
          borderColor: '#2a2a30',
          hoverBorderColor: '#3f3f46',
          focusBorderColor: '{primary.400}',
          invalidBorderColor: '#f87171',
          color: '#ededee',
          disabledColor: '#52525b',
          placeholderColor: '#71717a',
          floatLabelColor: '#a1a1aa',
          floatLabelFocusColor: '{primary.400}',
          floatLabelActiveColor: '#a1a1aa',
          floatLabelInvalidColor: '#f87171',
          iconColor: '#71717a',
          shadow: 'none',
        },
        content: {
          background: '#131316',
          hoverBackground: '#18181b',
          borderColor: '#1f1f23',
          color: '#ededee',
          hoverColor: '#ffffff',
        },
        overlay: {
          select: {
            background: '#18181b',
            borderColor: '#2a2a30',
            color: '#ededee',
          },
          popover: {
            background: '#0c0c0e',
            borderColor: '#2a2a30',
            color: '#ededee',
          },
          modal: {
            background: '#0c0c0e',
            borderColor: '#2a2a30',
            color: '#ededee',
          },
        },
      },
      light: {
        primary: {
          color: '{primary.500}',
          contrastColor: '#ffffff',
          hoverColor: '{primary.600}',
          activeColor: '{primary.700}',
        },
      },
    },
  },
});
