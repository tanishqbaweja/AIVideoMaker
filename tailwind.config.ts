import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}"
  ],
  theme: {
    extend: {
      colors: {
        vgen: {
          black: "#0F0F0F",
          panel: "#1A1A1A",
          panel2: "#202020",
          border: "#2D2D2D",
          text: "#F3F3F3",
          muted: "#929292",
          yellow: "#F9C74F",
          orange: "#F3722C"
        }
      },
      boxShadow: {
        glow: "0 0 32px rgba(249, 199, 79, 0.14)"
      }
    }
  },
  plugins: []
};

export default config;
