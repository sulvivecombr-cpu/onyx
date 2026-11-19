"""Large tool results in a chat with a sandbox: the full text goes to a file
in the user's VM, and the model, the live events and the saved history get a
preview with the file's path (`spill_large_result`, the chat agent's
prepare_tool_result hook)."""

import re

from onyx.agents.models import ToolResultContext
from onyx.llm.models import ToolResult
from onyx.server.features.build.sandbox.harness_base import ONYX_VM_FILES_ROOT
from onyx.tools.constants import FILE_READER_TOOL_NAME, SKILLS_READ_TOOL_NAME
from onyx.tools.models import CustomToolCallSummary, CustomToolUserFileSnapshot
from onyx.tools.tool_implementations.sandbox.sandbox_tools import (
    ExecCommandTool,
    WriteStdinTool,
)
from onyx.tools.tool_implementations.sandbox.turn import SandboxTurn
from onyx.tools.tool_implementations.utils import truncation_marker
from onyx.utils.logger import setup_logger

logger = setup_logger()

TOOL_RESULTS_DIR = f"{ONYX_VM_FILES_ROOT}/tool-results"
# Sizes are in characters, which track the model's context cost more closely
# than UTF-8 bytes and cost nothing to measure.
RESULT_MAX_CHARS = 50_000
RESULT_MAX_LINES = 2_000
# All results of one step; a result that arrives after the budget is used up
# spills even when it is under the limits of one result.
STEP_MAX_CHARS = 200_000
PREVIEW_HEAD_CHARS = 2_000
PREVIEW_TAIL_CHARS = 1_000
SPILL_MAX_BYTES = 64 << 20
# Exec output spills from the tools' own output buffer; read_file and
# skills_read page through their text, so a spill would only be read back.
_KEEPS_RESULT = frozenset(
    {
        ExecCommandTool.NAME,
        WriteStdinTool.NAME,
        FILE_READER_TOOL_NAME,
        SKILLS_READ_TOOL_NAME,
    }
)
_UNSAFE_NAME_CHARACTERS = re.compile(r"[^A-Za-z0-9_.-]")


def spill_large_result(turn: SandboxTurn, context: ToolResultContext) -> ToolResult:
    """The result, or, when it is too large, a preview and the path of the
    file in the VM that holds its full text. The write wakes the VM if needed;
    when it fails, the model gets the preview's head and tail with a note.
    Writing the same call's result again replaces the file."""
    result = context.result
    text = result.content
    call = context.calls[0]
    # A result that fits in the preview stays whole.
    if call.name in _KEEPS_RESULT or len(text) <= (
        PREVIEW_HEAD_CHARS + PREVIEW_TAIL_CHARS
    ):
        return result
    step_chars = sum(len(recorded.content) for recorded in context.step_results)
    lines = text.count("\n") + (not text.endswith("\n"))
    if (
        len(text) <= RESULT_MAX_CHARS
        and lines <= RESULT_MAX_LINES
        and step_chars + len(text) <= STEP_MAX_CHARS
    ):
        return result

    head = text[:PREVIEW_HEAD_CHARS]
    tail = text[-PREVIEW_TAIL_CHARS:]
    # Call IDs are unique only within one conversation, and one VM serves all
    # of the user's chats and subagents, so the step's message ID leads.
    name = _UNSAFE_NAME_CHARACTERS.sub("_", f"{context.message_id}_{call.id}")
    path = f"{TOOL_RESULTS_DIR}/{name}.txt"
    data = text.encode()
    try:
        turn.sandbox.write_onyx_file(turn.start_call(), path, data[:SPILL_MAX_BYTES])
    except Exception:
        logger.exception("tool_result_spill_failed call=%s path=%s", call.id, path)
        content = (
            head
            + truncation_marker(len(text) - len(head) - len(tail))
            + tail
            + "\n[The result was too large, and the sandbox could not save the "
            "full text, so the middle is left out.]"
        )
    else:
        cut = (
            f"Only the first {SPILL_MAX_BYTES >> 20} MiB is saved.\n"
            if len(data) > SPILL_MAX_BYTES
            else ""
        )
        content = (
            f'<persisted-output path="{path}" bytes={len(data)} lines={lines}>\n'
            f"Preview (first {PREVIEW_HEAD_CHARS:,} characters):\n{head}\n"
            f"Preview (last {PREVIEW_TAIL_CHARS:,} characters):\n{tail}\n"
            f"{cut}The full output is saved. Use {ExecCommandTool.NAME} (grep, "
            "sed, head, tail) on the path for the rest.\n"
            "</persisted-output>"
        )
    # A custom or MCP tool's output in the details becomes what the model
    # got, so the saved history never holds text that the model did not get.
    details = result.details
    if isinstance(details, CustomToolCallSummary) and not isinstance(
        details.tool_result, CustomToolUserFileSnapshot
    ):
        details = details.model_copy(
            update={"tool_result": content, "structured_result": None}
        )
    return result.model_copy(update={"content": content, "details": details})
