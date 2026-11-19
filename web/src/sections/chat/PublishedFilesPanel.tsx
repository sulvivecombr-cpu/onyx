"use client";

import { useTranslations } from "next-intl";
import { Button, Divider, Modal } from "@opal/components";
import { ContentAction, Section } from "@opal/layouts";
import { SvgFiles, SvgX } from "@opal/icons";
import type { PublishedFile } from "@/app/app/services/streamingModels";
import { PublishedFileCards } from "@/sections/chat/PublishedFileCards";

interface PublishedFilesPanelProps {
  // The newest publish of each path, newest first
  files: PublishedFile[];
  onClose: () => void;
}

/** The files the model published in a chat. */
export function PublishedFilesPanel({
  files,
  onClose,
}: PublishedFilesPanelProps) {
  const t = useTranslations("chat.publishedFiles");

  return (
    <aside
      aria-label={t("panel.title")}
      className="bg-background-tint-01 overflow-y-auto h-full w-full border-s"
    >
      <div className="sticky top-0 z-sticky bg-background-tint-01">
        <ContentAction
          font="heading-section"
          icon={SvgFiles}
          title={t("panel.title")}
          padding={2}
          rightChildren={
            <Button
              icon={SvgX}
              prominence="tertiary"
              onClick={onClose}
              tooltip={t("panel.closeButton.tooltip")}
              aria-label={t("panel.closeButton.tooltip")}
            />
          }
        />
        <Divider paddingParallel={0} paddingPerpendicular={0} />
      </div>
      <Section padding={3} alignItems="start" height="fit">
        <PublishedFileCards files={files} />
      </Section>
    </aside>
  );
}

interface PublishedFilesButtonProps {
  pressed: boolean;
  onClick: () => void;
}

/** Opens and closes the published files panel. */
export function PublishedFilesButton({
  pressed,
  onClick,
}: PublishedFilesButtonProps) {
  const t = useTranslations("chat.publishedFiles");

  return (
    <Button
      icon={SvgFiles}
      prominence="tertiary"
      interaction={pressed ? "hover" : "rest"}
      responsiveHideText
      onClick={onClick}
      tooltip={t("openButton.tooltip")}
      aria-label={t("openButton.label")}
      aria-pressed={pressed}
    >
      {t("openButton.label")}
    </Button>
  );
}

interface PublishedFilesModalProps {
  files: PublishedFile[];
  onClose: () => void;
}

/** The published files panel in a modal, for narrow screens. */
export function PublishedFilesModal({
  files,
  onClose,
}: PublishedFilesModalProps) {
  const t = useTranslations("chat.publishedFiles");

  return (
    <Modal open onOpenChange={onClose}>
      <Modal.Content>
        <Modal.Header
          icon={SvgFiles}
          title={t("panel.title")}
          onClose={onClose}
        />
        <Modal.Body>
          <PublishedFileCards files={files} />
        </Modal.Body>
      </Modal.Content>
    </Modal>
  );
}
