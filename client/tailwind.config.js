import colors from "tailwindcss/colors";

/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        primary: "#20423f",
        accent: "#b3852a",
        // Semantic tokens (UI-Foundation) — aliases over the existing
        // Tailwind palette, not new colors: success/danger/warning/info
        // already appeared ad hoc as emerald/red/amber/sky in individual
        // components (Dashboard's statusColor, BudgetPanel's over-budget
        // red). Centralizing them here means every future MIDAD screen
        // reaches for the same names instead of re-picking a shade.
        success: colors.emerald,
        danger: colors.red,
        warning: colors.amber,
        info: colors.sky,
      },
    },
  },
  plugins: [],
};
