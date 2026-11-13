// 원격 refresh 자격은 서버·pin별 AES-GCM으로 봉인한다.
// IndexedDB의 non-extractable CryptoKey를 사용하며 평문 토큰은 저장하지 않는다.
// 동일 origin에서 실행되는 악성 JavaScript를 막는 장치는 아니다.
const DB = "grove.e2ee.credentials.v1";
type Entry = { key: CryptoKey; iv: Uint8Array<ArrayBuffer>; data: ArrayBuffer };

function database(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB, 1);
        request.onupgradeneeded = () => request.result.createObjectStore("credentials");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function read(scope: string): Promise<Entry | undefined> {
    const db = await database();
    try {
        return await new Promise((resolve, reject) => {
            const request = db.transaction("credentials").objectStore("credentials").get(scope);
            request.onsuccess = () => resolve(request.result as Entry | undefined);
            request.onerror = () => reject(request.error);
        });
    } finally { db.close(); }
}

export async function loadCredential(scope: string): Promise<string> {
    const entry = await read(scope);
    if (!entry) return "";
    const plain = await crypto.subtle.decrypt({
        name: "AES-GCM", iv: entry.iv, additionalData: new TextEncoder().encode(scope),
    }, entry.key, entry.data);
    return new TextDecoder().decode(plain);
}

export async function saveCredential(scope: string, cookie: string): Promise<void> {
    let entry: Entry | null = null;
    if (cookie) {
        const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(scope) }, key, new TextEncoder().encode(cookie));
        entry = { key, iv, data };
    }
    const db = await database();
    try {
        await new Promise<void>((resolve, reject) => {
            const transaction = db.transaction("credentials", "readwrite");
            const store = transaction.objectStore("credentials");
            if (entry) store.put(entry, scope); else store.delete(scope);
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
            transaction.onabort = () => reject(transaction.error);
        });
    } finally { db.close(); }
}
