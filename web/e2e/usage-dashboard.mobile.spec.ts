import { test } from "@playwright/test";
import { checkDashboard } from "./usage-dashboard-checks";

test("모바일 통합 사용량은 세로 요약·가로 스크롤 표·터치·기간·모달 닫기를 지원한다", async ({ page }, info) => {
    await checkDashboard(page, info);
});
