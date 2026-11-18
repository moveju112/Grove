import { defineTheme } from "@astryxdesign/core/theme";
import grove, { uiFontStack } from "./grove.theme";

const tokens = {
    "--font-family-body": uiFontStack,
    "--bg": "#e9ebee",
    "--panel": "#f3f4f6",
    "--raised": "#e4e6ea",
    "--hover": "#dfe2e7",
    "--sel": "#d8dce2",
    "--split-bg": "#dce7f5",
    "--split-line": "#2f72b8",
    "--line": "#d5d8de",
    "--line-strong": "#c4c8d0",
    "--text": "#2b2d33",
    "--text-2": "#43464e",
    "--muted": "#5b5f68",
    "--bubble": "#e4e6ea",
    "--accent": "#2b2d33",
    "--accent-weak": "#d8dce2",
    "--accent-ink": "#34373e",
    "--warn": "#8a5300",
    "--err": "#a8301f",
    "--ok": "#2a7d50",
    "--focus": "#51545c",
    "--on-accent": "#ffffff",
    "--warn-weak": "#f1e7d6",
    "--err-weak": "#f3dfdb",
    "--brand": "#2f7d55",
} as const;

export default defineTheme({ name: "grove-soft", extends: grove, tokens });
