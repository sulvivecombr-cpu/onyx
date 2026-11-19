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
 * `branchFiles` is the session load's list for the branch, oldest first.
 * Loaded messages are read from their packets instead, so live publishes and
 * a branch switch show at once. The load's entries of messages that are not
 * loaded come first: those messages are older than every loaded one.
 */
export function latestPublishedFiles(
  branchFiles: readonly ChatPublishedFile[],
  messageTree: MessageTreeState,
  branch: readonly Message[]
): PublishedFile[] {
  const loadedMessageIds = new Set(
    [...messageTree.values()].map((message) => message.messageId)
  );
  const seenFileIds = new Set<string>();
  const newestByPath = new Map<string, PublishedFile>();
  for (const file of [
    ...branchFiles.filter((file) => !loadedMessageIds.has(file.message_id)),
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
