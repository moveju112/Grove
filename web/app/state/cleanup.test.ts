import { describe, expect, it } from "vitest";
import { clearDeviceCopies } from "./cleanup";

class MemStorage implements Storage {
    private m = new Map<string, string>();
    get length() {
        return this.m.size;
    }
    clear() {
        this.m.clear();
    }
    getItem(k: string) {
        return this.m.get(k) ?? null;
    }
    key(i: number) {
        return [...this.m.keys()][i] ?? null;
    }
    removeItem(k: string) {
        this.m.delete(k);
    }
    setItem(k: string, v: string) {
        this.m.set(k, v);
    }
}

describe("logout cleanup", () => {
    it("removes conversation copies and layout but keeps device id and display prefs", () => {
        const s = new MemStorage();
        for (const k of ["grove.draft.session:1:tab", "grove.draft.project:2:new", "grove.file.buffer.copy", "grove.file.attempt.copy", "grove.file.view.copy", "grove.layout.desktop", "grove.script.run.project.key", "grove.composer.options", "grove.bots.hidden", "grove.device.id", "grove.device.prefs", "other.app"]) {
            s.setItem(k, "x");
        }
        clearDeviceCopies(s);
        expect([...Array(s.length).keys()].map((i) => s.key(i)).sort()).toEqual(["grove.device.id", "grove.device.prefs", "other.app"]);
    });
});
