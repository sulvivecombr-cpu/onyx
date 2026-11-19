import { render, screen, within } from "@tests/setup/test-utils";
import type { PublishedFile } from "@/app/app/services/streamingModels";
import { PublishedFilesPanel } from "@/sections/chat/PublishedFilesPanel";

function file(
  fileId: string,
  name: string,
  title: string | null
): PublishedFile {
  return {
    file_id: fileId,
    name,
    title,
    path: `/home/onyx/${name}`,
    size: 2048,
    mime_type: "text/markdown",
  };
}

test("lists each file with its title, else its name", () => {
  const onClose = jest.fn();
  render(
    <PublishedFilesPanel
      files={[
        file("file-2", "report.md", "Q3 report"),
        file("file-3", "chart.png", null),
      ]}
      onClose={onClose}
    />
  );

  const panel = screen.getByRole("complementary", { name: "Files" });
  const cards = within(panel).getAllByRole("button", { name: /^Preview / });
  expect(cards.map((card) => card.getAttribute("aria-label"))).toEqual([
    "Preview report.md",
    "Preview chart.png",
  ]);
  expect(within(cards[0]!).getByText("Q3 report")).toBeInTheDocument();
  expect(within(cards[0]!).getByText(/^MD · 2/)).toBeInTheDocument();
  expect(within(cards[1]!).getByText("chart.png")).toBeInTheDocument();

  const downloads = within(panel).getAllByRole("link", { name: "Download" });
  expect(downloads.map((link) => link.getAttribute("href"))).toEqual([
    "/api/chat/file/file-2",
    "/api/chat/file/file-3",
  ]);

  within(panel).getByRole("button", { name: "Close files" }).click();
  expect(onClose).toHaveBeenCalledTimes(1);
});
