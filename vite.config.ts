import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { nitro } from "nitro/vite";

export default defineConfig(({ isSsrBuild }) => ({
  envPrefix: ["VITE_", "NEXT_PUBLIC_"],
  build: isSsrBuild
    ? {}
    : {
        rolldownOptions: {
          output: {
            codeSplitting: {
              groups: [
                {
                  name: "vendor",
                  test: /node_modules[\\/]/,
                  minSize: 30_000,
                  maxSize: 220_000,
                },
              ],
            },
          },
        },
      },
  resolve: {
    tsconfigPaths: true,
  },
  plugins: [
    tanstackStart({
      server: { entry: "server" },
    }),
    nitro({
      preset: "vercel",
      rolldownConfig: { output: { inlineDynamicImports: true } },
    }),
    react(),
    tailwindcss(),
  ],
}));
