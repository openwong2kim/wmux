/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './index.html',
    './src/renderer/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      // `font-sans` must resolve to the same stack the app body uses. Without
      // this it fell back to Tailwind's default system stack, which is exactly
      // the wrong answer at the four sites that use it — each one exists to
      // leave a mono ancestor and re-enter UI prose.
      fontFamily: {
        sans: ['var(--font-ui)'],
      },
    },
  },
  plugins: [],
};
