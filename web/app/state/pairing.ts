import type { PairingInfo } from "../api/generated";
import { hostOrigin } from "./hosts";
import { connectionLink, parseConnectionLink } from "../api/transport";

const codePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/;

export function parsePairingLink(link: string): { origin: string; code: string } {
    const parts = link.trim().split("#");
    if (parts.length !== 2 || !parts[1]!.startsWith("pairing=")) throw new Error("올바른 Grove 페어링 링크를 입력하세요.");
    const origin = hostOrigin(parts[0]!);
    const code = parts[1]!.slice("pairing=".length);
    if (!codePattern.test(code)) throw new Error("올바른 Grove 페어링 링크를 입력하세요.");
    return { origin, code };
}

export function pairingLink(origin: string, code: string): string {
    if (!codePattern.test(code)) throw new Error("서버의 페어링 응답이 올바르지 않습니다.");
    return hostOrigin(origin) + "/#pairing=" + code;
}

export function pairingStatus(info: Pick<PairingInfo, "expires_at" | "revoked_at" | "consumed_at">, now = Date.now()): "대기 중" | "만료됨" | "폐기됨" | "사용됨" {
    if (info.consumed_at) return "사용됨";
    if (info.revoked_at) return "폐기됨";
    return Date.parse(info.expires_at) > now ? "대기 중" : "만료됨";
}

export async function scanPairingImage(file: File): Promise<string> {
    if (file.size > 10 * 1024 * 1024) throw new Error("QR 이미지는 10MiB 이하로 선택하세요.");
    const bitmap = await createImageBitmap(file);
    try {
        const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        const context = canvas.getContext("2d")!;
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        const image = context.getImageData(0, 0, canvas.width, canvas.height);
        const { default: jsQR } = await import("jsqr");
        const result = jsQR(image.data, image.width, image.height);
        if (!result) throw new Error("QR을 찾지 못했습니다. 선명한 이미지를 선택하거나 링크를 붙여 넣으세요.");
        if (new URL(result.data).hash.startsWith("#connect=")) {
            const parsed = parseConnectionLink(result.data);
            return connectionLink(parsed.connection, parsed.code);
        }
        const { origin, code } = parsePairingLink(result.data);
        return pairingLink(origin, code);
    } finally {
        bitmap.close();
    }
}
