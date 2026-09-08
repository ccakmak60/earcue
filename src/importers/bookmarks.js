// Parses the Netscape bookmarks HTML format exported by Chrome, Edge, and Firefox alike.

function folderPathFor(anchor) {
  const parts = [];
  let dl = anchor.closest("dl");
  while (dl) {
    const prev = dl.previousElementSibling;
    if (prev && prev.tagName === "H3") {
      parts.unshift(prev.textContent.trim());
    }
    const parent = dl.parentElement;
    dl = parent ? parent.closest("dl") : null;
  }
  return parts.join("/");
}

export function parseBookmarksHtml(text) {
  const doc = new DOMParser().parseFromString(text, "text/html");
  const rows = [];

  for (const a of doc.querySelectorAll("a[href]")) {
    const url = a.getAttribute("href");
    if (!url) continue;

    const row = {
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
