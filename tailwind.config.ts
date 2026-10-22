import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "var(--ink)",
        muted: "var(--muted)",
        line: "var(--line)",
        primary: "var(--primary)",
        surface: "var(--surface)",
        canvas: "var(--bg)"
      },
      maxWidth: {
        workspace: "1296px",
        brand: "1360px"
      },
      boxShadow: {
        card: "0 8px 25px rgba(41, 50, 66, 0.06)",
        popover: "0 14px 40px rgba(26, 35, 53, 0.14)"
      }
    }
  },
  plugins: []
};

export default config;
