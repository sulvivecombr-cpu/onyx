import { fireEvent, render, screen } from "@tests/setup/test-utils";
import { ChatSidePanel } from "@/sections/chat/ChatSidePanel";

interface ViewProps {
  open: boolean;
  onClose: () => void;
}

function View({ open, onClose }: ViewProps) {
  return (
    <>
      <button type="button">Open</button>
      <ChatSidePanel open={open} onClose={onClose}>
        <button type="button">Inside</button>
      </ChatSidePanel>
    </>
  );
}

test("a closed panel is inert, and closing returns focus to its opener", () => {
  const onClose = jest.fn();
  const { rerender } = render(<View open={false} onClose={onClose} />);
  const inside = screen.getByText("Inside");
  expect(inside.closest("[inert]")).not.toBeNull();

  const opener = screen.getByText("Open");
  opener.focus();
  rerender(<View open onClose={onClose} />);
  expect(inside.closest("[inert]")).toBeNull();
  // Opening moves focus into the panel.
  expect(inside.closest("[tabindex='-1']")).toBe(document.activeElement);

  fireEvent.keyDown(inside, { key: "Escape" });
  expect(onClose).toHaveBeenCalledTimes(1);

  rerender(<View open={false} onClose={onClose} />);
  expect(document.activeElement).toBe(opener);
});
