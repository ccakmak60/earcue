// Parses the Netscape bookmarks HTML format exported by Chrome, Edge, and Firefox alike.
// Uses DOMParser, so it runs in the browser (or a jsdom test environment), not on the server.
import type { BookmarkRow } from "../types";

function folderPathFor(anchor: Element): string {
  const parts: string[] = [];
  let dl = anchor.closest("dl");
  while (dl) {
    const prev = dl.previousElementSibling;
    if (prev && prev.tagName === "H3") {
      parts.unshift((prev.textContent || "").trim());
    }
    const parent: HTMLElement | null = dl.parentElement;
    dl = parent ? parent.closest("dl") : null;
  }
  return parts.join("/");
}

export function parseBookmarksHtml(text: string): BookmarkRow[] {
  const doc = new DOMParser().parseFromString(text, "text/html");
  const rows: BookmarkRow[] = [];

  for (const a of doc.querySelectorAll("a[href]")) {
    const url = a.getAttribute("href");
    if (!url) continue;

    const row: BookmarkRow = {
      url,
      title: a.textContent || "",
      folder: folderPathFor(a),
    };
    const addDate = a.getAttribute("add_date");
    if (addDate) {
      row.addedAt = new Date(Number(addDate) * 1000).toISOString();
    }
    rows.push(row);
  }

  return rows;
}
