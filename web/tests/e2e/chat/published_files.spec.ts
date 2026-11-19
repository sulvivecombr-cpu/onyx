import type { Page } from "@playwright/test";
import { test, expect } from "@tests/e2e/chat/fixtures";
import { sendMessage } from "@tests/e2e/utils/chatActions";
import {
  buildMockPublishFilesStream,
  MockPublishedFile,
  mockChatEndpoint,
  publishFilesPackets,
  resetTurnCounter,
} from "@tests/e2e/utils/chatMock";

const REPORT_TEXT = "Revenue grew in every region.";
const MESSAGE = "The report is ready.";

function report(fileId: string, title: string | null): MockPublishedFile {
  return {
    fileId,
    name: "report.md",
    title,
    path: "/home/onyx/workspaces/chat/report.md",
    size: 2048,
    mimeType: "text/markdown",
  };
}

async function mockFile(page: Page, file: MockPublishedFile): Promise<void> {
  await page.route(`**/api/chat/file/${file.fileId}*`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: file.mimeType,
      headers: {
        "Content-Disposition": `attachment; filename="${file.name}"`,
      },
      body: `# Q3\n\n${REPORT_TEXT}\n`,
    });
  });
}

interface SavedMessage {
  message_id: number;
  message_type: "user" | "assistant";
  parent_message: number | null;
  latest_child_message: number | null;
  message: string;
  files: { id: string; type: string; name: string }[];
  time_sent: string;
  citations: Record<string, never>;
  context_docs: null;
  tool_call: null;
  research_type: null;
  rephrased_query: null;
  overridden_model: string;
  alternate_assistant_id: null;
  current_feedback: null;
  sub_questions: [];
  error: null;
}

function savedMessage(
  message: Pick<
    SavedMessage,
    | "message_id"
    | "message_type"
    | "parent_message"
    | "latest_child_message"
    | "message"
    | "files"
  >
): SavedMessage {
  return {
    ...message,
    time_sent: new Date().toISOString(),
    citations: {},
    context_docs: null,
    tool_call: null,
    research_type: null,
    rephrased_query: null,
    overridden_model: "",
    alternate_assistant_id: null,
    current_feedback: null,
    sub_questions: [],
    error: null,
  };
}

test.describe("Published files", () => {
  test.beforeEach(() => {
    resetTurnCounter();
  });

  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: "ignoreErrors" });
  });

  test("a published file shows as a card that previews and downloads", async ({
    page,
    chatPage,
  }) => {
    const file = report("published-file-1", "Q3 report");
    await chatPage.goto();
    await mockFile(page, file);
    await mockChatEndpoint(page, buildMockPublishFilesStream([file], MESSAGE));

    await sendMessage(page, "Write the quarterly report");
    await expect(chatPage.answerText(MESSAGE)).toBeVisible();
    await expect(chatPage.publishedFileCards()).toHaveCount(1);
    await chatPage.expectPublishedFile("Q3 report", {
      fileName: file.name,
      details: /MD · 2/,
      href: `/api/chat/file/${file.fileId}`,
    });
    await chatPage.expectPublishedFilePreview("Q3 report", REPORT_TEXT);
  });

  test("a saved reply shows a card for each publish, and the panel the newest of each path", async ({
    page,
    chatPage,
    api,
  }) => {
    const first = report("published-file-2", "Q3 report");
    const second = report("published-file-3", null);
    // Published by an older answer that the paged load does not hold.
    const notes: MockPublishedFile = {
      ...report("published-file-6", "Meeting notes"),
      name: "notes.md",
      path: "/home/onyx/workspaces/chat/notes.md",
    };
    const sessionId = await api.createChatSession("Published files");
    try {
      await mockFile(page, first);
      await mockFile(page, second);
      await mockFile(page, notes);
      const replay = [
        ...publishFilesPackets(0, [first]),
        ...publishFilesPackets(1, [second]),
        {
          placement: { turn_index: 2, tab_index: 0 },
          obj: {
            type: "message_start",
            id: "saved-answer",
            content: MESSAGE,
            final_documents: null,
          },
        },
        {
          placement: { turn_index: 2, tab_index: 0 },
          obj: { type: "stop", stop_reason: "finished" },
        },
      ];
      await page.route(
        `**/api/chat/get-chat-session/${sessionId}*`,
        async (route) => {
          const response = await route.fetch();
          const saved: Record<string, unknown> = await response.json();
          await route.fulfill({
            response,
            json: {
              ...saved,
              messages: [
                savedMessage({
                  message_id: 1,
                  message_type: "user",
                  parent_message: null,
                  latest_child_message: 2,
                  message: "Write the quarterly report",
                  files: [],
                }),
                savedMessage({
                  message_id: 2,
                  message_type: "assistant",
                  parent_message: 1,
                  latest_child_message: null,
                  message: MESSAGE,
                  files: [first, second].map((file) => ({
                    id: file.fileId,
                    type: "document",
                    name: file.name,
                  })),
                }),
              ],
              packets: [replay],
              published_files: [
                { file: notes, messageId: 0 },
                { file: first, messageId: 2 },
                { file: second, messageId: 2 },
              ].map(({ file, messageId }) => ({
                file_id: file.fileId,
                name: file.name,
                title: file.title,
                path: file.path,
                size: file.size,
                mime_type: file.mimeType,
                message_id: messageId,
              })),
            },
          });
        }
      );

      await chatPage.goto(sessionId);
      await expect(chatPage.answerText(MESSAGE)).toBeVisible();
      await expect(chatPage.publishedFileCards()).toHaveCount(2);
      await chatPage.expectPublishedFile("Q3 report", {
        fileName: first.name,
        details: /MD · 2/,
        href: `/api/chat/file/${first.fileId}`,
      });
      // The second publish of the path has no title, so it shows its name.
      await chatPage.expectPublishedFile(second.name, {
        fileName: second.name,
        details: /MD · 2/,
        href: `/api/chat/file/${second.fileId}`,
      });
      await chatPage.expectPublishedFilePreview(second.name, REPORT_TEXT);

      // The panel shows the newest publish of each path, also of the answer
      // that the page did not load.
      await chatPage.publishedFilesButton.click();
      await expect(chatPage.publishedFilesPanelCards()).toHaveCount(2);
      await chatPage.expectPublishedFilesPanelFile(0, {
        text: second.name,
        href: `/api/chat/file/${second.fileId}`,
      });
      await chatPage.expectPublishedFilesPanelFile(1, {
        text: "Meeting notes",
        href: `/api/chat/file/${notes.fileId}`,
      });
    } finally {
      await api.deleteChatSession(sessionId);
    }
  });

  test("the files panel shows the newest publish of a path across replies and previews it", async ({
    page,
    chatPage,
  }) => {
    const first = report("published-file-4", "Q3 report");
    const second = report("published-file-5", "Q3 report, final");
    const finalMessage = "The final report is ready.";
    await chatPage.goto();
    await mockFile(page, first);
    await mockFile(page, second);

    await mockChatEndpoint(page, buildMockPublishFilesStream([first], MESSAGE));
    await sendMessage(page, "Write the quarterly report");
    await expect(chatPage.answerText(MESSAGE)).toBeVisible();
    await mockChatEndpoint(
      page,
      buildMockPublishFilesStream([second], finalMessage)
    );
    await sendMessage(page, "Finalize the report");
    await expect(chatPage.answerText(finalMessage, 1)).toBeVisible();

    await expect(chatPage.publishedFilesPanel).toBeHidden();
    await chatPage.publishedFilesButton.click();
    await expect(chatPage.publishedFilesPanel).toBeVisible();

    // Both replies published one path: the panel shows only the newest.
    await expect(chatPage.publishedFilesPanelCards()).toHaveCount(1);
    await chatPage.expectPublishedFilesPanelFile(0, {
      text: "Q3 report, final",
      href: `/api/chat/file/${second.fileId}`,
    });
    await chatPage.expectPublishedFilesPanelPreview(0, REPORT_TEXT);

    await chatPage.publishedFilesButton.click();
    await expect(chatPage.publishedFilesPanel).toBeHidden();
  });
});
