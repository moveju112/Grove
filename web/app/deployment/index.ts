import { deploymentPaths } from "./base";

export { deploymentPaths, normalizeBasePath } from "./base";

// Vite의 실제 asset base를 사용한다. 런타임에 별도 base를 추측하지 않는다.
export const deployment = deploymentPaths(import.meta.env.BASE_URL);
