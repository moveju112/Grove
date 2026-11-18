import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";
import stylex from "@stylexjs/unplugin";
import { normalizeBasePath } from "./app/deployment/base";

// 개발 시 /api는 로컬 Grove 서버로 전달한다.
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const apiTarget = env.GROVE_DEV_API ?? "http://127.0.0.1:7740";

export default defineConfig(({ mode }) => ({
    base: normalizeBasePath(env.GROVE_WEB_BASE),
    plugins: [
        stylex.vite({ useCSSLayers: true, runtimeInjection: false }),
        ...(mode === "test" ? [] : [reactRouter()]),
    ],
    server: {
        proxy: {
            "/api": { target: apiTarget, changeOrigin: false },
        },
    },
    build: {
        target: "es2022",
        sourcemap: false,
        rollupOptions: {
            output: {
                manualChunks(id) {
                    if (/\/node_modules\/(?:react|react-dom|react-router|scheduler)\//.test(id)) return "react-vendor";
                },
            },
        },
    },
    test: {
        include: ["app/**/*.test.{ts,tsx}"],
        environment: "node",
    },
}));
