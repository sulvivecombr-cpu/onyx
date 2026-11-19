import { act, render, screen, within } from "@tests/setup/test-utils";
import type { PublishedFile } from "@/app/app/services/streamingModels";
import { PublishedFilesPanel } from "@/sections/chat/PublishedFilesPanel";
import { fetchChatFile } from "@/lib/chat/svc";

jest.mock("@/lib/chat/svc", () => ({
  ...jest.requireActual("@/lib/chat/svc"),
  fetchChatFile: jest.fn(),
}));

const MARKDOWN = "# Q3\n\nRevenue grew.";

function markdownResponse(): Response {
  const headers: Record<string, string> = {
    "Content-Type": "text/markdown",
    "Content-Disposition": 'attachment; filename="report.md"',
  };
  const response: Pick<Response, "headers" | "blob" | "body"> = {
    headers: { get: (name: string) => headers[name] ?? null } as Headers,
    blob: async () =>
      ({
        text: async () => MARKDOWN,
        type: "text/markdown",
      }) as unknown as Blob,
    body: null,
  };
  return response as unknown as Response;
}

beforeAll(() => {
  Object.defineProperty(window.URL, "createObjectURL", {
    configurable: true,
    value: () => "blob:report",
  });
  Object.defineProperty(window.URL, "revokeObjectURL", {
    configurable: true,
    value: () => undefined,
  });
});

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

test("lists each file with its title, else its name, and no version label", () => {
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
  expect(within(panel).queryByText(/version/i)).toBeNull();

  const downloads = within(panel).getAllByRole("link", { name: "Download" });
  expect(downloads.map((link) => link.getAttribute("href"))).toEqual([
    "/api/chat/file/file-2",
    "/api/chat/file/file-3",
  ]);

  within(panel).getByRole("button", { name: "Close files" }).click();
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("a file in the panel previews", async () => {
  jest.mocked(fetchChatFile).mockResolvedValue(markdownResponse());
  render(
    <PublishedFilesPanel
      files={[file("file-md", "report.md", "Q3 report")]}
      onClose={() => undefined}
    />
  );

  await act(async () => {
    screen.getByRole("button", { name: "Preview report.md" }).click();
  });

  const dialog = await screen.findByRole("dialog");
  expect(fetchChatFile).toHaveBeenCalledWith("file-md");
  expect(await within(dialog).findByText("Revenue grew.")).toBeVisible();
});
