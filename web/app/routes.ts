import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [index("routes/app.tsx"), route("*", "routes/app.tsx", { id: "fallback" })] satisfies RouteConfig;
