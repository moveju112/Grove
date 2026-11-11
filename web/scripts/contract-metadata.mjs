// ts-rs가 만든 선언만 읽는다. 지원하지 않는 구문은 검증을 생략하지 않고 생성을 실패시킨다.
import ts from "typescript";

let source = "";
for await (const chunk of process.stdin) source += chunk;
const file = ts.createSourceFile("generated.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
if (file.parseDiagnostics.length) throw new Error("계약 TypeScript 구문 오류");

function schema(node) {
    const primitive = {
        [ts.SyntaxKind.StringKeyword]: "string",
        [ts.SyntaxKind.NumberKeyword]: "number",
        [ts.SyntaxKind.BooleanKeyword]: "boolean",
        [ts.SyntaxKind.UnknownKeyword]: "unknown",
    }[node.kind];
    if (primitive) return { kind: primitive };
    if (ts.isParenthesizedTypeNode(node)) return schema(node.type);
    if (ts.isUnionTypeNode(node)) return { kind: "union", options: node.types.map(schema) };
    if (ts.isArrayTypeNode(node)) return { kind: "array", item: schema(node.elementType) };
    if (ts.isLiteralTypeNode(node)) {
        if (node.literal.kind === ts.SyntaxKind.NullKeyword) return { kind: "literal", value: null };
        if (node.literal.kind === ts.SyntaxKind.TrueKeyword) return { kind: "literal", value: true };
        if (node.literal.kind === ts.SyntaxKind.FalseKeyword) return { kind: "literal", value: false };
        if (ts.isStringLiteral(node.literal)) return { kind: "literal", value: node.literal.text };
        if (ts.isNumericLiteral(node.literal)) return { kind: "literal", value: Number(node.literal.text) };
    }
    if (ts.isTypeReferenceNode(node)) {
        const name = node.typeName.getText(file);
        if (name === "Array" && node.typeArguments?.length === 1) return { kind: "array", item: schema(node.typeArguments[0]) };
        if (!node.typeArguments?.length && names.has(name)) return { kind: "ref", name };
    }
    if (ts.isTypeLiteralNode(node)) {
        const fields = {};
        for (const member of node.members) {
            if (!ts.isPropertySignature(member) || !member.type ||
                !(ts.isIdentifier(member.name) || ts.isStringLiteral(member.name))) {
                throw new Error(`지원하지 않는 계약 필드: ${member.getText(file)}`);
            }
            fields[member.name.text] = { optional: !!member.questionToken, schema: schema(member.type) };
        }
        return { kind: "object", fields };
    }
    throw new Error(`지원하지 않는 계약 타입: ${node.getText(file)}`);
}

const declarations = file.statements.filter(ts.isTypeAliasDeclaration);
if (declarations.length !== file.statements.length) throw new Error("계약에는 type 선언만 허용됩니다");
const names = new Set(declarations.map((d) => d.name.text));
const lines = declarations.map((d) => `    ${JSON.stringify(d.name.text)}: ${JSON.stringify(schema(d.type))},`);
process.stdout.write(
    "// 이 파일은 tests/ts_bindings.rs가 Rust 계약에서 생성한다. 직접 수정하지 않는다.\n" +
    'import type * as Types from "./generated";\nimport type { Schema } from "./validation";\n\n' +
    "export type ContractTypes = {\n" + declarations.map((d) => `    ${d.name.text}: Types.${d.name.text};\n`).join("") +
    "};\n\nexport const contractMetadata = {\n" + lines.join("\n") +
    "\n} as const satisfies Record<keyof ContractTypes, Schema>;\n",
);
