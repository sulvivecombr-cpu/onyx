import {
  type Packet,
  PacketType,
  type PublishedFile,
} from "@/app/app/services/streamingModels";
import type { ChatPublishedFile, Message } from "@/app/app/types";
import {
  latestPublishedFiles,
  readPublishedFiles,
} from "@/lib/chat/publishedFiles";

function published(
  fileId: string,
  path: string,
  title: string | null = null
): PublishedFile {
  return {
    file_id: fileId,
    name: path.split("/").pop() ?? path,
    title,
    path,
    display_path: path,
    size: 10,
    mime_type: "text/markdown",
  };
}

function loaded(file: PublishedFile, messageId: number): ChatPublishedFile {
  return { ...file, message_id: messageId };
}

function publishEnd(files: PublishedFile[], subTurnIndex?: number): Packet {
  return {
    placement: { turn_index: 0, tab_index: 0, sub_turn_index: subTurnIndex },
    obj: { type: PacketType.PUBLISH_FILES_END, files, error: null },
  };
}

function response(
  nodeId: number,
  messageId: number | undefined,
  packets: Packet[]
): Message {
  return {
    nodeId,
    messageId,
    type: "assistant",
    message: "",
    files: [],
    packets,
    toolCall: null,
    parentNodeId: null,
  };
}

function tree(messages: Message[]): Map<number, Message> {
  return new Map(messages.map((message) => [message.nodeId, message]));
}

describe("readPublishedFiles", () => {
  test("reads every publish_files result, nested calls included", () => {
    const packets = [
      publishEnd([published("a", "/w/report.md")]),
      publishEnd([published("b", "/w/chart.png")], 0),
    ];

    expect(readPublishedFiles(packets).map((file) => file.file_id)).toEqual([
      "a",
      "b",
    ]);

    // A stream appends to the same array.
    packets.push(publishEnd([published("c", "/w/notes.md")]));
    expect(readPublishedFiles(packets).map((file) => file.file_id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });
});

describe("latestPublishedFiles", () => {
  test("keeps the newest publish of each path, newest first", () => {
    const answer = response(2, 2, [
      publishEnd([
        published("a", "/w/report.md", "Draft"),
        published("b", "/w/chart.png"),
      ]),
      publishEnd([published("c", "/w/report.md")]),
      // A repeated report of one call adds nothing.
      publishEnd([published("c", "/w/report.md")]),
    ]);

    expect(
      latestPublishedFiles([], tree([answer]), [answer]).map(
        ({ file_id, title }) => [file_id, title]
      )
    ).toEqual([
      ["c", null],
      ["b", null],
    ]);
  });

  test("merges the load's list with live publishes by path", () => {
    // The load lists an older answer that is not loaded, and the loaded
    // answer, with a file of its background subagent that its packets lack.
    const branchFiles = [
      loaded(published("old-report", "/w/report.md", "Report"), 2),
      loaded(published("old-chart", "/w/chart.png"), 2),
      loaded(published("loaded", "/w/data.csv"), 6),
      loaded(published("subagent", "/w/notes.md"), 6),
    ];
    const saved = response(6, 6, [
      publishEnd([published("loaded", "/w/data.csv")]),
    ]);
    // A live answer, with no saved ID yet, publishes the report's path again.
    const live = response(-1, undefined, [
      publishEnd([published("new-report", "/w/report.md", "Report v2")]),
    ]);

    expect(
      latestPublishedFiles(branchFiles, tree([saved, live]), [saved, live]).map(
        ({ file_id, title }) => [file_id, title]
      )
    ).toEqual([
      ["new-report", "Report v2"],
      ["subagent", null],
      ["loaded", null],
      ["old-chart", null],
    ]);
  });

  test("leaves out the load's files of loaded messages off the branch", () => {
    // A branch switch: answer 6 is loaded but no longer on the branch.
    const branchFiles = [loaded(published("switched", "/w/report.md"), 6)];
    const hidden = response(6, 6, [
      publishEnd([published("switched", "/w/report.md")]),
    ]);
    const shown = response(7, 7, []);

    expect(
      latestPublishedFiles(branchFiles, tree([hidden, shown]), [shown])
    ).toEqual([]);
  });
});
