import { act, render, screen, within } from "@tests/setup/test-utils";
import { PublishedFileCards } from "@/sections/chat/PublishedFileCards";
import { fetchChatFile } from "@/lib/chat/svc";

jest.mock("@/lib/chat/svc", () => ({
  ...jest.requireActual("@/lib/chat/svc"),
  fetchChatFile: jest.fn(),
}));

const HTML = "<h1>Quarterly report</h1>";

function htmlResponse(): Response {
  const headers: Record<string, string> = {
    "Content-Type": "text/html",
    "Content-Disposition": 'attachment; filename="report.html"',
  };
  const response: Pick<Response, "headers" | "blob" | "body"> = {
    headers: { get: (name: string) => headers[name] ?? null } as Headers,
    blob: async () =>
      ({ text: async () => HTML, type: "text/html" }) as unknown as Blob,
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

test("a card shows the title, type and size, and downloads the file", () => {
  render(
    <PublishedFileCards
      files={[
        {
          file_id: "file-1",
          name: "report.csv",
          title: "Q3 report",
          path: "/home/onyx/report.csv",
          size: 2048,
          mime_type: "text/csv",
        },
        {
          file_id: "file-2",
          name: "report.csv",
          title: null,
          path: "/home/onyx/report.csv",
          size: 512,
          mime_type: "text/csv",
        },
      ]}
    />
  );

  const cards = screen.getAllByRole("button", { name: "Preview report.csv" });
  expect(cards).toHaveLength(2);
  expect(within(cards[0]!).getByText("Q3 report")).toBeInTheDocument();
  expect(within(cards[0]!).getByText(/^CSV · 2/)).toBeInTheDocument();
  expect(within(cards[1]!).getByText("report.csv")).toBeInTheDocument();
  expect(within(cards[1]!).getByText(/^CSV · 512/)).toBeInTheDocument();

  const downloads = screen.getAllByRole("link", { name: "Download" });
  expect(downloads[0]).toHaveAttribute("href", "/api/chat/file/file-1");
  expect(downloads[0]).toHaveAttribute("download", "report.csv");
  expect(downloads[1]).toHaveAttribute("href", "/api/chat/file/file-2");
});

test("files that show one name also show their path in the chat's folder", () => {
  const workspace =
    "/home/onyx/workspaces/0e3b8a52-4b1f-4c5e-9d0a-1a2b3c4d5e6f";
  const csv = (fileId: string, path: string, title: string | null = null) => ({
    file_id: fileId,
    name: path.split("/").pop() ?? path,
    title,
    path,
    size: 512,
    mime_type: "text/csv",
  });
  render(
    <PublishedFileCards
      files={[
        csv("drafts", `${workspace}/drafts/summary.csv`),
        csv("final", `${workspace}/final/summary.csv`),
        csv("outside", "/tmp/onyx/summary.csv"),
        csv("unique", `${workspace}/drafts/report.csv`),
        // Only a title shares a name with nothing: it shows no path.
        csv("titled", `${workspace}/other/summary.csv`, "Summary"),
      ]}
    />
  );

  const descriptions = [
    ...screen.getAllByRole("button", { name: /^Preview / }),
  ].map((card) => card.textContent);
  expect(descriptions[0]).toContain("drafts/summary.csv · CSV · 512");
  expect(descriptions[1]).toContain("final/summary.csv · CSV · 512");
  expect(descriptions[2]).toContain("/tmp/onyx/summary.csv · CSV · 512");
  expect(descriptions[3]).not.toContain("drafts/");
  expect(descriptions[4]).not.toContain("other/");
});

test("an HTML file previews as source, not as a rendered page", async () => {
  jest.mocked(fetchChatFile).mockResolvedValue(htmlResponse());
  const view = render(
    <PublishedFileCards
      files={[
        {
          file_id: "file-html",
          name: "report.html",
          title: null,
          path: "/home/onyx/report.html",
          size: HTML.length,
          mime_type: "text/html",
        },
      ]}
    />
  );

  await act(async () => {
    screen.getByRole("button", { name: "Preview report.html" }).click();
  });

  const dialog = await screen.findByRole("dialog");
  expect(fetchChatFile).toHaveBeenCalledWith("file-html");
  // The code view shows the markup itself.
  expect(await within(dialog).findByText(/Quarterly report/)).toBeVisible();
  expect(dialog).toHaveTextContent(HTML);
  expect(view.container.ownerDocument.querySelector("iframe")).toBeNull();
});
