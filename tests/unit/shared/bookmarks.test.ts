// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { parseBookmarksHtml } from "@/lib/shared/importers/bookmarks";

describe("parseBookmarksHtml", () => {
  it("takes the folder from the enclosing H3 and converts add_date from epoch seconds", () => {
    const rows = parseBookmarksHtml(
      '<DL><DT><H3>Work</H3><DL><DT><A HREF="https://a.example/x?token=1" ADD_DATE="1700000000">A</A></DL></DL>'
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].folder).toBe("Work");
    expect(rows[0].addedAt).toBe(new Date(1700000000 * 1000).toISOString());
  });
});
