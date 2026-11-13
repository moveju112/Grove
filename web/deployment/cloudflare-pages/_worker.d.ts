type PagesEnvironment = {
    /** 빌드와 같은 정규화된 base. 생략하면 루트. */
    GROVE_WEB_BASE?: string;
    ASSETS: { fetch(request: Request): Promise<Response> };
};

declare const worker: {
    fetch(request: Request, env: PagesEnvironment): Promise<Response>;
};
export default worker;
