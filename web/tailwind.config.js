/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        navy: {
          DEFAULT: '#10273e',
          700: '#0b1d2e',
        },
        ink: { DEFAULT: '#1a2733', soft: '#5b6b7c', mute: '#8a97a5' },
        line: '#e3e6ea',
        page: '#f6f7f9',
        brand: { DEFAULT: '#1a5490', hover: '#164a7f', soft: '#e8f0f9' },
        danger: { DEFAULT: '#b42318', soft: '#fdecea' },
        warn: { DEFAULT: '#a15c07', soft: '#fdf3e3' },
        good: { DEFAULT: '#1c7c54', soft: '#e7f4ee' },
      },
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      borderRadius: { card: '8px' },
      boxShadow: { card: '0 1px 2px rgba(16,39,62,0.04)' },
    },
  },
  plugins: [],
};
