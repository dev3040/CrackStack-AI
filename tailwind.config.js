/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Consolas', 'monospace'],
      },
      colors: {
        copilot: {
          bg: '#0c0d10',
          surface: '#14161c',
          border: '#252830',
          muted: '#6b7280',
          accent: '#22d3ee',
        },
      },
    },
  },
  plugins: [],
};
