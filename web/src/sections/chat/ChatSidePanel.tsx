"use client";

import { type ReactNode, useEffect, useRef } from "react";
import { cn } from "@opal/utils";
import { useEscapeInterrupt } from "@/hooks/useEscapeInterrupt";

interface ChatSidePanelProps {
  open: boolean;
  onClose: () => void;
  // Where the panel sits, when its host does not place it
  className?: string;
  children: ReactNode;
}

/**
 * A chat side panel (Sources, Files) that slides open. A closed panel is
 * inert: not focusable and not announced. Opening moves focus into the panel,
 * Escape in it closes it, and closing returns focus to the element that
 * opened it.
 */
export function ChatSidePanel({
  open,
  onClose,
  className,
  children,
}: ChatSidePanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(open);

  useEffect(() => {
    const panel = panelRef.current;
    const wasOpen = wasOpenRef.current;
    wasOpenRef.current = open;
    if (!panel || open === wasOpen) return;
    if (open) {
      openerRef.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      panel.focus({ preventScroll: true });
      return;
    }
    const opener = openerRef.current;
    openerRef.current = null;
    // Only when focus was in the panel, which an inert panel drops
    const focused = document.activeElement;
    if (
      opener?.isConnected &&
      (focused === null || focused === document.body || panel.contains(focused))
    ) {
      opener.focus({ preventScroll: true });
    }
  }, [open]);

  // Esc closes only the top layer: a dialog that the panel opened first.
  useEscapeInterrupt({ enabled: open, onInterrupt: onClose, within: panelRef });

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      inert={!open}
      className={cn(
        "overflow-hidden transition-all duration-300 ease-in-out h-full outline-none",
        open ? "w-100" : "w-0",
        className
      )}
    >
      {children}
    </div>
  );
}
