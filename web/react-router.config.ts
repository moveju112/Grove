import type { Config } from "@react-router/dev/config";
import { deploymentPaths } from "./app/deployment/base";

// 정적 SPA로 배포한다. 런타임 SSR 서버는 없다(Rust 서버가 정적 파일을 제공).
export default {
    basename: deploymentPaths(process.env.GROVE_WEB_BASE).basename,
    ssr: false,
    appDirectory: "app",
    buildDirectory: "build",
    // 현재 7.x 동작을 명시적으로 유지한다. 8.x 전환은 프레임워크 업데이트와 함께 검증한다.
    future: {
        v8_middleware: false,
        v8_splitRouteModules: false,
        v8_viteEnvironmentApi: false,
        v8_passThroughRequests: false,
        v8_trailingSlashAwareDataRequests: false,
    },
} satisfies Config;
