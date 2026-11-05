import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { nitro } from "nitro/vite";

export default defineConfig(() => ({
  envPrefix: ["VITE_", "NEXT_PUBLIC_"],
  resolve: {
    tsconfigPaths: true,
  },
  // Vendor-split ONLY the client bundle: the nitro/server environment runs
  // with code splitting disabled and rejects manualChunks.
  environments: {
    client: {
      build: {
        rollupOptions: {
          output: {
            // Split heavy vendors out of the entry chunk (previously >500 kB in
            // one index-*.js). Long-lived chunks also cache independently.
            manualChunks(id: string) {
              if (!id.includes("node_modules")) return undefined;
              if (
                id.includes("node_modules/react-dom") ||
                id.includes("node_modules/react/") ||
                id.includes("node_modules/scheduler")
              ) {
                return "vendor-react";
              }
              if (id.includes("node_modules/@supabase")) return "vendor-supabase";
              if (id.includes("node_modules/@tanstack")) return "vendor-tanstack";
              if (
                id.includes("node_modules/@radix-ui") ||
                id.includes("node_modules/lucide-react")
              ) {
                return "vendor-ui";
              }
              return "vendor";
            },
          },
        },
      },
    },
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
