import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { HTTP_STATUS } from "../src/http-status.ts";

const STATUS_VALUES = new Set<number>(Object.values(HTTP_STATUS));
const STATUS_ARGUMENT_INDEX = new Map([
  ["json", 1],
  ["finish", 0],
  ["writeHead", 0],
  ["saveClientOpResult", 3],
]);

function runtimeTypeScriptFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return runtimeTypeScriptFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
}

function callName(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return null;
}

function isStatusPropertyName(name: ts.PropertyName): boolean {
  return (
    (ts.isIdentifier(name) || ts.isStringLiteral(name)) &&
    (name.text === "status" || name.text === "statusCode")
  );
}

function isHttpStatusLiteral(node: ts.NumericLiteral): boolean {
  const parent = node.parent;
  if (
    ((ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) &&
      isStatusPropertyName(parent.name)) ||
    (ts.isBinaryExpression(parent) &&
      parent.right === node &&
      ts.isPropertyAccessExpression(parent.left) &&
      (parent.left.name.text === "status" ||
        parent.left.name.text === "statusCode"))
  ) {
    return true;
  }

  let child: ts.Node = node;
  let ancestor = node.parent;
  while (!ts.isCallExpression(ancestor)) {
    if (ts.isSourceFile(ancestor)) return false;
    child = ancestor;
    ancestor = ancestor.parent;
  }
  const expectedIndex = STATUS_ARGUMENT_INDEX.get(
    callName(ancestor.expression) ?? "",
  );
  return ancestor.arguments[expectedIndex ?? -1] === child;
}

describe("HTTP_STATUS", () => {
  it("maps the runtime HTTP statuses used by WebAgent", () => {
    assert.deepEqual(HTTP_STATUS, {
      OK: 200,
      CREATED: 201,
      ACCEPTED: 202,
      NO_CONTENT: 204,
      BAD_REQUEST: 400,
      UNAUTHORIZED: 401,
      FORBIDDEN: 403,
      NOT_FOUND: 404,
      CONFLICT: 409,
      GONE: 410,
      PAYLOAD_TOO_LARGE: 413,
      UNPROCESSABLE_CONTENT: 422,
      INTERNAL_SERVER_ERROR: 500,
      NOT_IMPLEMENTED: 501,
      SERVICE_UNAVAILABLE: 503,
    });
  });

  it("is used instead of status literals in runtime code", () => {
    const violations: string[] = [];
    const files = [
      ...runtimeTypeScriptFiles("src"),
      ...runtimeTypeScriptFiles("public/js"),
    ].filter((file) => file !== "src/http-status.ts");

    for (const file of files) {
      const text = readFileSync(file, "utf8");
      const source = ts.createSourceFile(
        file,
        text,
        ts.ScriptTarget.Latest,
        true,
      );
      const visit = (node: ts.Node): void => {
        if (
          ts.isNumericLiteral(node) &&
          STATUS_VALUES.has(Number(node.text)) &&
          isHttpStatusLiteral(node)
        ) {
          const { line } = source.getLineAndCharacterOfPosition(
            node.getStart(source),
          );
          violations.push(
            `${relative(process.cwd(), file)}:${line + 1}: ${node.text}`,
          );
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }

    assert.deepEqual(violations, []);
  });
});
