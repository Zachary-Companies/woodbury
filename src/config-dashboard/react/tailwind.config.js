/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/config-dashboard/react/**/*.{tsx,ts,jsx,js}'],
  important: '#react-pipeline-root',
  corePlugins: {
    preflight: false,
  },
  theme: {
    extend: {},
  },
  plugins: [],
};
