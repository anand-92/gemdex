export default {content: [
  './index.html',
  './src/**/*.{js,ts,jsx,tsx}'
],
  theme: {
    extend: {
      colors: {
        canvas: '#08090c',
        panel: {
          DEFAULT: '#0f1116',
          hover: '#15181f',
          deep: '#0b0d11',
          line: '#1a1e26',
        },
        edge: {
          DEFAULT: 'rgba(255,255,255,0.07)',
          strong: 'rgba(255,255,255,0.13)',
          accent: 'rgba(108,140,255,0.38)',
          ok: 'rgba(61,220,151,0.30)',
          warn: 'rgba(255,200,87,0.30)',
        },
        ink: {
          DEFAULT: '#f3f5f8',
          dim: '#c4cad5',
          muted: '#8b93a1',
          faint: '#5c6373',
        },
        accent: {
          DEFAULT: '#6c8cff',
          hover: '#8ba3ff',
          deep: '#4d6bf0',
        },
        iris: '#a78bfa',
        ok: '#3ddc97',
        warn: '#ffc857',
        danger: '#ff5d5d',
      },
      borderRadius: {
        card: '14px',
        panel: '18px',
        pill: '999px',
      },
      fontFamily: {
        sans: ['Geist', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
        mono: ['Geist Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      boxShadow: {
        card: '0 1px 0 0 rgba(255,255,255,0.05) inset, 0 18px 40px -24px rgba(0,0,0,0.9)',
        lift: '0 1px 0 0 rgba(255,255,255,0.06) inset, 0 24px 50px -26px rgba(0,0,0,1)',
        glow: '0 0 0 1px rgba(108,140,255,0.35), 0 18px 46px -22px rgba(108,140,255,0.55)',
        'glow-sm': '0 0 22px -6px rgba(108,140,255,0.55)',
        'glow-ok': '0 0 20px -6px rgba(61,220,151,0.5)',
        'glow-danger': '0 0 34px -12px rgba(255,93,93,0.6)',
        modal: '0 40px 90px -30px rgba(0,0,0,1)',
      },
      keyframes: {
        'pulse-ring': {
          '0%,100%': { opacity: '0.9', transform: 'scale(1)' },
          '50%': { opacity: '0.35', transform: 'scale(1.35)' },
        },
        drift: {
          '0%,100%': { transform: 'translate3d(0,0,0)' },
          '50%': { transform: 'translate3d(2%,-3%,0)' },
        },
      },
      animation: {
        'pulse-ring': 'pulse-ring 2.4s ease-in-out infinite',
        drift: 'drift 22s ease-in-out infinite',
      },
    },
  },
}
