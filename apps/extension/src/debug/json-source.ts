/** JSON structure backed by source ranges. Numbers never pass through Number. */
export interface JsonSource {
  start: number;
  end: number;
  kind: "object" | "array" | "string" | "primitive";
  children?: { key: string; value: JsonSource }[];
}

export function parseJsonSource(text: string): JsonSource {
  // Let the platform validate grammar; discard its potentially rounded values.
  JSON.parse(text);
  const tokens = text.matchAll(/"(?:[^"\\]|\\.)*"|[{}\[\]:,]|[^\s{}\[\]:,]+/g);
  let token = tokens.next().value!;
  const next = () => {
    token = tokens.next().value!;
  };
  const read = (depth: number): JsonSource => {
    if (depth > 64) throw new Error("JSON structure exceeds depth limit");
    const raw = token[0];
    const node: JsonSource = {
      start: token.index!,
      end: token.index! + raw.length,
      kind:
        raw === "{" ? "object" : raw === "[" ? "array" : raw[0] === '"' ? "string" : "primitive",
    };
    next();
    if (node.kind === "object" || node.kind === "array") {
      node.children = [];
      const end = node.kind === "object" ? "}" : "]";
      while (token[0] !== end) {
        let key = String(node.children.length);
        if (node.kind === "object") {
          key = JSON.parse(token[0]);
          next(); // colon
          next(); // value
        }
        node.children.push({ key, value: read(depth + 1) });
        if (token[0] === ",") next();
      }
      node.end = token.index! + 1;
      next();
    }
    return node;
  };
  return read(0);
}

export function jsonPointer(text: string, pointer: string): string {
  if (pointer !== "" && !pointer.startsWith("/"))
    throw new Error("pointer must be an RFC 6901 JSON pointer");
  let node = parseJsonSource(text);
  for (const token of pointer === "" ? [] : pointer.slice(1).split("/")) {
    if (/~(?:[^01]|$)/.test(token)) throw new Error("invalid JSON pointer escape");
    const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
    const child = node.children?.findLast((child) => child.key === key);
    if (!child) throw new Error("JSON pointer not found");
    node = child.value;
  }
  return text.slice(node.start, node.end);
}
