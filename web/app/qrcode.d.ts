// 사용하는 browser API만 선언한다. QR 처리 구현은 고정 버전 qrcode 패키지에 둔다.
declare module "qrcode" {
    const QRCode: {
        toCanvas(canvas: HTMLCanvasElement, text: string, options: { width: number; margin: number; errorCorrectionLevel: "M" }): Promise<void>;
    };
    export default QRCode;
}
