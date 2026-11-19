import { useChatSessionStore } from "@/app/app/stores/useChatSessionStore";
import { loadSelectedBranch } from "@/lib/chat/pagedSession";

const SESSION = "branch-session";

function pageSwitch(): number | null | undefined {
  return useChatSessionStore.getState().sessions.get(SESSION)?.latestPageSwitch;
}

function deferred(): {
  promise: Promise<Response>;
  resolve: (response: Response) => void;
} {
  let resolve: (response: Response) => void = () => undefined;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const page = new Response(
  JSON.stringify({ messages: [], packets: [], published_files: [] }),
  { status: 200 }
);

beforeEach(() => {
  useChatSessionStore.setState({
    sessions: new Map(),
    currentSessionId: SESSION,
  });
  useChatSessionStore.getState().createSession(SESSION);
  jest.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => jest.restoreAllMocks());

describe("loadSelectedBranch", () => {
  test("marks the page pending until the reload ends", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(page.clone());
    const save = deferred();
    const loading = loadSelectedBranch(SESSION, save.promise, true);
    expect(pageSwitch()).not.toBeNull();

    save.resolve(new Response(null, { status: 200 }));
    await expect(loading).resolves.toBe(true);
    expect(pageSwitch()).toBeNull();
  });

  test("a switch that needs no reload marks nothing", async () => {
    const loading = loadSelectedBranch(
      SESSION,
      Promise.resolve(new Response(null, { status: 200 })),
      false
    );
    expect(pageSwitch()).toBeNull();
    await loading;
  });

  test("clears the mark when the server refuses the branch", async () => {
    await expect(
      loadSelectedBranch(
        SESSION,
        Promise.resolve(new Response(null, { status: 500 })),
        true
      )
    ).resolves.toBe(false);
    expect(pageSwitch()).toBeNull();
  });

  test("clears the mark when the save or the reload throws", async () => {
    await expect(
      loadSelectedBranch(SESSION, Promise.reject(new Error("offline")), true)
    ).rejects.toThrow("offline");
    expect(pageSwitch()).toBeNull();

    jest.spyOn(global, "fetch").mockRejectedValue(new Error("offline"));
    await loadSelectedBranch(
      SESSION,
      Promise.resolve(new Response(null, { status: 200 })),
      true
    );
    expect(pageSwitch()).toBeNull();
  });

  test("only the newest of two quick switches clears the mark", async () => {
    jest.spyOn(global, "fetch").mockImplementation(async () => page.clone());
    const first = deferred();
    const second = deferred();
    const firstLoading = loadSelectedBranch(SESSION, first.promise, true);
    const secondLoading = loadSelectedBranch(SESSION, second.promise, true);

    first.resolve(new Response(null, { status: 200 }));
    await firstLoading;
    expect(pageSwitch()).not.toBeNull();

    second.resolve(new Response(null, { status: 200 }));
    await secondLoading;
    expect(pageSwitch()).toBeNull();
  });

  test("does not recreate a chat that left the store meanwhile", async () => {
    const save = deferred();
    const loading = loadSelectedBranch(SESSION, save.promise, true);
    useChatSessionStore.setState({ sessions: new Map() });
    save.resolve(new Response(null, { status: 500 }));
    await loading;
    expect(useChatSessionStore.getState().sessions.has(SESSION)).toBe(false);
  });
});
