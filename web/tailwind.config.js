/**
 * 1CS brand palette. These values are the source of truth for the application
 * shell; the marketing site carries the same system in public/site.css.
 *
 * Every pair below is checked for WCAG AA against the surface it sits on:
 *   ink        16.4:1 on white      ink.soft  7.3:1     ink.mute  5.0:1
 *   brand      6.3:1 with white     good      5.2:1 with white
 *
 * `brand` (blue) is the primary action inside the product; the green is
 * reserved for confirmation, exactly as the check mark in the logo is.
 *
 * @type {import('tailwindcss').Config}
 */
export default {
  content: ['./app.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        navy: {
          DEFAULT: '#021432',
          700: '#010d22',
        },
        ink: { DEFAULT: '#0f1f3d', soft: '#48586e', mute: '#5f7089' },
        line: '#dce3eb',
        page: '#f2f5f7',
        brand: { DEFAULT: '#185ac6', hover: '#033380', soft: '#e7effc' },
        lime: '#94c63d',
        danger: { DEFAULT: '#b42318', soft: '#fdecea' },
        warn: { DEFAULT: '#a15c07', soft: '#fdf3e3' },
        good: { DEFAULT: '#2c7a52', soft: '#e9f4ee' },
      },
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      borderRadius: { card: '8px' },
      boxShadow: { card: '0 1px 2px rgba(2,20,50,0.05)' },
    },
  },
  plugins: [],
};
