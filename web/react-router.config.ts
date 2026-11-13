import type { Config } from "@react-router/dev/config";
import { deploymentPaths } from "./app/deployment/base";

// 정적 SPA로 배포한다. 런타임 SSR 서버는 없다(Rust 서버가 정적 파일을 제공).
export default {
    basename: deploymentPaths(process.env.GROVE_WEB_BASE).basename,
    ssr: false,
    appDirectory: "app",
    buildDirectory: "build",
} satisfies Config;
