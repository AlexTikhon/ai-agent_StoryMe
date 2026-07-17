import type { Config } from 'tailwindcss';

/**
 * Tailwind configuration encoding all design tokens from DESIGN_SYSTEM.md.
 * Primary: Story Violet (#6535E0)
 * Secondary: Celebration Amber (#F5A800)
 * Neutral: Warm Stone (paper-like, bookish warmth)
 * Fonts: Fraunces (display), Plus Jakarta Sans (UI), Lora (book reader)
 */
const config: Config = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],

  theme: {
    extend: {
      // ── Color Palette ────────────────────────────────────────────────────
      colors: {
        // Primary — Story Violet
        violet: {
          50: '#F8F5FF',
          100: '#EEE8FF',
          200: '#D9CEFF',
          300: '#BBA8FF',
          400: '#9879F8',
          500: '#7B54F0',
          600: '#6535E0', // Primary brand — CTAs, links
          700: '#5122C4',
          800: '#3E19A0',
          900: '#2D1180',
          950: '#180960',
        },

        // Secondary — Celebration Amber
        amber: {
          50: '#FFFCF0',
          100: '#FFF5CC',
          200: '#FFE99A',
          300: '#FFD966',
          400: '#FFC833',
          500: '#F5A800', // Celebration / success accent
          600: '#CC8800',
          700: '#A36A00',
          800: '#7A4E00',
          900: '#523300',
        },

        // Neutral — Warm Stone (bookish paper tones)
        stone: {
          50: '#FAFAF8',
          100: '#F5F4F1',
          200: '#E8E6E1',
          300: '#D6D3CC',
          400: '#A8A49B',
          500: '#79746A',
          600: '#57524A',
          700: '#3F3A33',
          800: '#28241E',
          900: '#1A1714',
          950: '#0D0B09',
        },

        // Semantic — Success
        success: {
          light: '#ECFDF5',
          base: '#16A34A',
          dark: '#15803D',
          fill: '#22C55E',
        },

        // Semantic — Warning
        warning: {
          light: '#FFFBEB',
          base: '#D97706',
          dark: '#B45309',
          fill: '#F59E0B',
        },

        // Semantic — Danger
        danger: {
          light: '#FEF2F2',
          base: '#DC2626',
          dark: '#B91C1C',
          fill: '#EF4444',
        },

        // Semantic — Info
        info: {
          light: '#EFF6FF',
          base: '#2563EB',
          dark: '#1D4ED8',
          fill: '#60A5FA',
        },

        // Background & surface tokens
        bg: {
          base: '#FDFCFB', // Main page background (slightly warm white)
          surface: '#FFFFFF', // Cards, modals, elevated surfaces
          subtle: '#F5F4F1', // Inset panels, striped rows
          muted: '#ECEAE5', // Hover on subtle
          inverse: '#1A1714', // Dark overlays, tooltips
          brand: '#6535E0', // Brand-colored sections
          'brand-subtle': '#F8F5FF', // Light violet surface
        },

        // Semantic text tokens
        text: {
          primary: '#28241E',
          secondary: '#57524A',
          muted: '#79746A',
          disabled: '#A8A49B',
          inverse: '#FDFCFB',
          brand: '#6535E0',
          'brand-subtle': '#7B54F0',
          danger: '#DC2626',
          success: '#15803D',
          warning: '#D97706',
        },

        // Border tokens
        border: {
          subtle: '#E8E6E1',
          default: '#D6D3CC',
          strong: '#A8A49B',
          inverse: '#3F3A33',
          brand: '#6535E0',
          danger: '#DC2626',
          success: '#16A34A',
        },
      },

      // ── Typography ────────────────────────────────────────────────────────
      fontFamily: {
        display: ['Fraunces', 'Georgia', '"Times New Roman"', 'serif'],
        sans: [
          '"Plus Jakarta Sans"',
          '-apple-system',
          'BlinkMacSystemFont',
          '"Segoe UI"',
          'sans-serif',
        ],
        body: [
          '"Plus Jakarta Sans"',
          '-apple-system',
          'BlinkMacSystemFont',
          '"Segoe UI"',
          'sans-serif',
        ],
        book: ['Lora', 'Georgia', 'serif'],
      },

      fontSize: {
        xs: ['0.75rem', { lineHeight: '1.5', letterSpacing: '0.02em' }],
        sm: ['0.875rem', { lineHeight: '1.5', letterSpacing: '0.01em' }],
        base: ['1rem', { lineHeight: '1.625', letterSpacing: '0' }],
        lg: ['1.125rem', { lineHeight: '1.5', letterSpacing: '-0.01em' }],
        xl: ['1.25rem', { lineHeight: '1.4', letterSpacing: '-0.01em' }],
        '2xl': ['1.5rem', { lineHeight: '1.35', letterSpacing: '-0.02em' }],
        '3xl': ['1.875rem', { lineHeight: '1.25', letterSpacing: '-0.02em' }],
        '4xl': ['2.25rem', { lineHeight: '1.2', letterSpacing: '-0.03em' }],
        '5xl': ['3rem', { lineHeight: '1.1', letterSpacing: '-0.03em' }],
        '6xl': ['3.75rem', { lineHeight: '1.05', letterSpacing: '-0.04em' }],
        '7xl': ['4.5rem', { lineHeight: '1.0', letterSpacing: '-0.04em' }],
      },

      // ── Spacing ───────────────────────────────────────────────────────────
      // Tailwind's default spacing already uses 4px base unit.
      // These are additional named tokens from DESIGN_SYSTEM.md §2.2.
      spacing: {
        px: '1px',
        '0.5': '2px',
      },

      // ── Border Radius ─────────────────────────────────────────────────────
      // Children's book aesthetic: rounded, playful
      borderRadius: {
        none: '0',
        sm: '6px',
        DEFAULT: '10px',
        md: '12px',
        lg: '16px',
        xl: '20px',
        '2xl': '24px',
        '3xl': '32px',
        full: '9999px',
      },

      // ── Box Shadows ───────────────────────────────────────────────────────
      boxShadow: {
        xs: '0 1px 2px 0 rgba(26,23,20,0.05)',
        sm: '0 2px 4px 0 rgba(26,23,20,0.06), 0 1px 2px -1px rgba(26,23,20,0.06)',
        DEFAULT: '0 4px 8px -2px rgba(26,23,20,0.1), 0 2px 4px -2px rgba(26,23,20,0.06)',
        md: '0 8px 16px -4px rgba(26,23,20,0.12), 0 4px 6px -4px rgba(26,23,20,0.06)',
        lg: '0 16px 32px -8px rgba(26,23,20,0.15), 0 6px 10px -6px rgba(26,23,20,0.06)',
        xl: '0 24px 48px -12px rgba(26,23,20,0.18)',
        '2xl': '0 40px 64px -16px rgba(26,23,20,0.22)',
        // Brand shadow (violet tint)
        brand: '0 8px 24px -4px rgba(101,53,224,0.25)',
        'brand-lg': '0 16px 40px -8px rgba(101,53,224,0.30)',
        // Celebration shadow (amber glow)
        celebration: '0 8px 24px -4px rgba(245,168,0,0.30)',
        none: 'none',
      },

      // ── Container widths ──────────────────────────────────────────────────
      maxWidth: {
        'container-xs': '480px',
        'container-sm': '640px',
        'container-md': '768px',
        'container-lg': '1024px',
        'container-xl': '1200px',
        'container-2xl': '1440px',
      },

      // ── Gradients ─────────────────────────────────────────────────────────
      backgroundImage: {
        'gradient-brand': 'linear-gradient(135deg, #6535E0 0%, #9879F8 100%)',
        'gradient-celebration': 'linear-gradient(135deg, #F5A800 0%, #FFD966 100%)',
        'gradient-warm-fade': 'linear-gradient(180deg, #FDFCFB 0%, #F5F4F1 100%)',
        'gradient-surface-fade': 'linear-gradient(180deg, transparent 0%, #FDFCFB 100%)',
        'gradient-cover-overlay':
          'linear-gradient(180deg, transparent 40%, rgba(26,23,20,0.7) 100%)',
      },

      // ── Animation ─────────────────────────────────────────────────────────
      keyframes: {
        'fade-in': {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'slide-in-right': {
          from: { opacity: '0', transform: 'translateX(24px)' },
          to: { opacity: '1', transform: 'translateX(0)' },
        },
        'slide-in-left': {
          from: { opacity: '0', transform: 'translateX(-24px)' },
          to: { opacity: '1', transform: 'translateX(0)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        'pulse-gentle': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.6' },
        },
      },
      animation: {
        'fade-in': 'fade-in 0.3s ease-out',
        'slide-in-right': 'slide-in-right 0.3s ease-out',
        'slide-in-left': 'slide-in-left 0.3s ease-out',
        shimmer: 'shimmer 2s linear infinite',
        'pulse-gentle': 'pulse-gentle 2s ease-in-out infinite',
      },
    },
  },

  plugins: [],
};

export default config;
