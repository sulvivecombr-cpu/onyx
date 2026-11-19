import {
  type Packet,
  PacketType,
  type PublishedFile,
} from "@/app/app/services/streamingModels";
import type { ChatPublishedFile, Message } from "@/app/app/types";
import type { MessageTreeState } from "@/app/app/services/messageTree";
import { type CachedRead, readOnce } from "@/lib/chat/packetReads";

const publishedFileReads = new WeakMap<Packet[], CachedRead<PublishedFile[]>>();
const PUBLISH_END_PACKETS: ReadonlySet<string> = new Set([
  PacketType.PUBLISH_FILES_END,
]);

/** The files that one response's publish_files calls published, in order. */
export function readPublishedFiles(packets: Packet[]): PublishedFile[] {
  return readOnce(publishedFileReads, packets, PUBLISH_END_PACKETS, (packets) =>
    packets.flatMap((packet) =>
      packet.obj.type === PacketType.PUBLISH_FILES_END ? packet.obj.files : []
    )
  );
}

/**
 * The chat's published files on the selected branch: the newest publish of
 * each path, newest first.
 *
 * `branchFiles` is the latest load's list for the branch, oldest first. It
 * also holds the files of messages that are not loaded and of the branch's
 * background subagents. The packets of the loaded branch add what the load
 * does not have yet, such as live publishes. A load entry of a loaded message
 * that is no longer on the branch, after a branch switch, is left out.
 */
export function latestPublishedFiles(
  branchFiles: readonly ChatPublishedFile[],
  messageTree: MessageTreeState,
  branch: readonly Message[]
): PublishedFile[] {
  const branchMessageIds = new Set(branch.map((message) => message.messageId));
  const offBranchMessageIds = new Set(
    [...messageTree.values()]
      .map((message) => message.messageId)
      .filter((messageId) => !branchMessageIds.has(messageId))
  );
  const seenFileIds = new Set<string>();
  const newestByPath = new Map<string, PublishedFile>();
  for (const file of [
    ...branchFiles.filter((file) => !offBranchMessageIds.has(file.message_id)),
    ...branch.flatMap((message) => readPublishedFiles(message.packets)),
  ]) {
    if (seenFileIds.has(file.file_id)) continue;
    seenFileIds.add(file.file_id);
    // Deleting first moves the path to the end: the newest publish
    newestByPath.delete(file.path);
    newestByPath.set(file.path, file);
  }
  return [...newestByPath.values()].reverse();
}
