/**
 * Read the value used by both recorded fills and fill verification.
 * Keep this function self-contained: the fill tool serializes it into the page.
 */
export function readFillableValue(this: HTMLElement): string {
  if (this.matches("input,textarea")) return (this as HTMLInputElement | HTMLTextAreaElement).value;
  const collapses = ["normal", "nowrap"].includes(getComputedStyle(this).whiteSpace);
  const isInline = (node: Node) => node.nodeType === Node.TEXT_NODE || node.nodeName === "BR";
  const isLine = (node: Node): node is HTMLDivElement =>
    node.nodeName === "DIV" &&
    getComputedStyle(node as Element).display === "block" &&
    [...node.childNodes].every(isInline);
  const nodes = [...this.childNodes];
  let value: string;
  // Chrome typing produces text, <br> and direct <div> lines. A final <br>
  // holds its line open; it does not add another newline to the editable value.
  if (nodes.every((node) => isInline(node) || isLine(node))) {
    const lines: Node[][] = [];
    let open: Node[] | undefined;
    for (const node of nodes) {
      if (isLine(node)) {
        lines.push([...node.childNodes]);
        open = undefined;
      } else {
        if (!open) lines.push((open = []));
        open.push(node);
      }
    }
    value = lines
      .flatMap((line) => {
        let text = line
          .map((node, index) =>
            node.nodeName !== "BR" ? (node as Text).data : index < line.length - 1 ? "\n" : "",
          )
          .join("");
        if (collapses) text = text.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
        return text === "" && !line.some((node) => node.nodeName === "BR") ? [] : [text];
      })
      .join("\n");
  } else {
    // Rich structures keep rendered text; a lone placeholder line is empty.
    const rendered = this.innerText;
    value = rendered === "\n" && this.textContent === "" ? "" : rendered;
  }
  // Chrome inserts NBSP at line edges in collapsing modes. Do not mutate the DOM.
  return collapses ? value.replace(/\u00a0/g, " ") : value;
}
