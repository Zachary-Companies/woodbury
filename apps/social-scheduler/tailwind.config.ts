import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        background: '#0f172a',
        foreground: '#e2e8f0',
        primary: '#7c3aed',
        'primary-hover': '#6d28d9',
        secondary: '#06b6d4',
        surface: '#1e293b',
        'surface-hover': '#334155',
        border: '#334155',
        muted: '#64748b',
        success: '#22c55e',
        warning: '#f59e0b',
        danger: '#ef4444',
      },
    },
  },
  plugins: [],
}
export default config
