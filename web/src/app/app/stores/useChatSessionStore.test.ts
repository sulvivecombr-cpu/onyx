import { useChatSessionStore } from "@/app/app/stores/useChatSessionStore";

function panel() {
  const session = useChatSessionStore.getState().sessions.get("session");
  return { panel: session?.rightPanel, visible: session?.rightPanelVisible };
}

beforeEach(() => {
  useChatSessionStore.setState({
    sessions: new Map(),
    currentSessionId: "session",
  });
  useChatSessionStore.getState().createSession("session");
});

describe("the right panel", () => {
  test("opening one panel replaces the other", () => {
    const { updateCurrentRightPanel } = useChatSessionStore.getState();
    updateCurrentRightPanel("sources", true);
    updateCurrentRightPanel("publishedFiles", true);
    expect(panel()).toEqual({ panel: "publishedFiles", visible: true });

    updateCurrentRightPanel("sources", true);
    expect(panel()).toEqual({ panel: "sources", visible: true });
  });

  test("closing one panel leaves the other open", () => {
    const { updateCurrentRightPanel } = useChatSessionStore.getState();
    updateCurrentRightPanel("publishedFiles", true);
    updateCurrentRightPanel("sources", false);
    expect(panel()).toEqual({ panel: "publishedFiles", visible: true });

    updateCurrentRightPanel("publishedFiles", false);
    // The panel stays named while it closes, so its content stays too.
    expect(panel()).toEqual({ panel: "publishedFiles", visible: false });
  });

  test("the delayed close of Sources does not close Files opened meanwhile", () => {
    jest.useFakeTimers();
    try {
      const { updateCurrentRightPanel } = useChatSessionStore.getState();
      updateCurrentRightPanel("sources", true);
      // The desktop Sources close waits 300 ms for its transition.
      setTimeout(() => updateCurrentRightPanel("sources", false), 300);
      updateCurrentRightPanel("publishedFiles", true);
      jest.advanceTimersByTime(300);
      expect(panel()).toEqual({ panel: "publishedFiles", visible: true });
    } finally {
      jest.useRealTimers();
    }
  });
});
