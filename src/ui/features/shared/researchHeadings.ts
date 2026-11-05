interface MarkdownNode {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  data?: { hProperties?: Record<string, unknown> };
}

function text(node: MarkdownNode): string {
  return node.value ?? node.children?.map(text).join("") ?? "";
}

// Only a short, bold lead-in ending in a colon is a paragraph label.
// Ordinary emphasized terms, including those wrapping to another visual line,
// retain the body typography.
export function researchHeadings() {
  return (tree: MarkdownNode): void => {
    const visit = (node: MarkdownNode): void => {
      if (node.type === "paragraph") {
        let atStart = true;
        for (const child of node.children ?? []) {
          if (child.type === "break") {
            atStart = true;
            continue;
          }
          if (child.type === "text" && !child.value?.trim()) continue;
          if (atStart && child.type === "strong") {
            const label = text(child).trim();
            if (label.length <= 24 && /[：:]$/.test(label)) {
              child.data = {
                ...child.data,
                hProperties: {
                  ...child.data?.hProperties,
                  className: "zrdb-research-label",
                },
              };
            }
          }
          atStart = false;
        }
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}
