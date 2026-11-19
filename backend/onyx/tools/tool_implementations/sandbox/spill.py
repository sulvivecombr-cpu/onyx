"""Large tool results in a chat with a sandbox: the full text goes to a file
in the user's VM, and the model, the live events and the saved history get a
preview with the file's path (`spill_large_result`, the chat agent's
prepare_tool_result hook)."""

import re

from onyx.agents.models import ToolResultContext
from onyx.llm.models import ToolResult
from onyx.server.features.build.sandbox.harness_base import ONYX_VM_FILES_ROOT
from onyx.tools.constants import (
    CITEABLE_TOOLS_NAMES,
    FILE_READER_TOOL_NAME,
    SKILLS_READ_TOOL_NAME,
)
from onyx.tools.models import CustomToolCallSummary, SpilledOutput
from onyx.tools.tool_implementations.sandbox.models import (
    RetainedOutputResult,
    SandboxExecResult,
)
from onyx.tools.tool_implementations.sandbox.sandbox_tools import ExecCommandTool
from onyx.tools.tool_implementations.sandbox.turn import SandboxTurn
from onyx.tools.tool_implementations.utils import truncation_marker
from onyx.utils.logger import setup_logger

logger = setup_logger()

TOOL_RESULTS_DIR = f"{ONYX_VM_FILES_ROOT}/tool-results"
# Sizes are in characters, which cost nothing to measure. They do not bound
# tokens: text such as CJK takes about one token for each character.
RESULT_MAX_CHARS = 50_000
RESULT_MAX_LINES = 2_000
# All results of one step; a result that arrives after the budget is used up
# spills even when it is under the limits of one result.
STEP_MAX_CHARS = 200_000
PREVIEW_HEAD_CHARS = 2_000
PREVIEW_TAIL_CHARS = 1_000
# A shorter result stays whole: its preview would save less than half of it.
SPILL_MIN_CHARS = 2 * (PREVIEW_HEAD_CHARS + PREVIEW_TAIL_CHARS)
SPILL_MAX_BYTES = 64 << 20
# read_file and skills_read page through their text, so a spill would only
# be read back; the citeable tools keep their own limits and citations.
_KEEPS_RESULT = frozenset(
    {
        FILE_READER_TOOL_NAME,
        SKILLS_READ_TOOL_NAME,
        *CITEABLE_TOOLS_NAMES,
    }
)
_UNSAFE_NAME_CHARACTERS = re.compile(r"[^A-Za-z0-9_.-]")


def spill_large_result(turn: SandboxTurn, context: ToolResultContext) -> ToolResult:
    """The result, or, when it is too large, a preview and the path of the
    file in the VM that holds its full text. The write wakes the VM if needed;
    when it fails, the model gets the preview's head and tail with a note.
    Writing the same call's result again replaces the file; an amendment
    writes its own file."""
    result = context.result
    # A result with output cut for the model (exec_command, write_stdin):
    # the limits and the file use all the output that the tool kept.
    retained = result if isinstance(result, RetainedOutputResult) else None
    text = result.content if retained is None else retained.retained_output
    call = context.calls[0]
    if call.name in _KEEPS_RESULT or len(text) <= SPILL_MIN_CHARS:
        return result
    step_chars = sum(len(recorded.content) for recorded in context.step_results)
    lines = text.count("\n") + (not text.endswith("\n"))
    if (
        len(text) <= RESULT_MAX_CHARS
        and lines <= RESULT_MAX_LINES
        and step_chars + len(result.content) <= STEP_MAX_CHARS
    ):
        return result

    head = text[:PREVIEW_HEAD_CHARS]
    tail = text[-PREVIEW_TAIL_CHARS:]
    # Call IDs are unique only within one conversation, and one VM serves all
    # of the user's chats and subagents, so the step's message ID leads.
    name = _UNSAFE_NAME_CHARACTERS.sub(
        "_",
        f"{context.message_id}_{call.id}" + ("_amended" if context.amended else ""),
    )
    path = f"{TOOL_RESULTS_DIR}/{name}.txt"
    data = b""
    spilled: SpilledOutput | None = None
    try:
        # Raises UnicodeEncodeError for text with a lone surrogate.
        data = text.encode()
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
        dropped = (
            f"The sandbox dropped {retained.omitted_bytes:,} bytes from the "
            "middle of the output; the file has the rest.\n"
            if retained is not None and retained.omitted_bytes
            else ""
        )
        content = (
            f'<persisted-output path="{path}" bytes={len(data)} lines={lines}>\n'
            f"Preview (first {PREVIEW_HEAD_CHARS:,} characters):\n{head}\n"
            f"Preview (last {PREVIEW_TAIL_CHARS:,} characters):\n{tail}\n"
            f"{cut}{dropped}The full output is in the file while the sandbox runs. Use "
            f"{ExecCommandTool.NAME} (grep, sed, head, tail) on the path for the "
            "rest. If the file is missing, the sandbox restarted; call the tool "
            "again.\n</persisted-output>"
        )
        spilled = SpilledOutput(head=head, tail=tail)
    # The output in the details of an exec call, or of a custom or MCP tool,
    # becomes the preview, so the saved history does not hold the text that
    # the model did not get. Python and code mode details keep their own
    # bounded output.
    details = result.details
    if isinstance(details, SandboxExecResult):
        details = details.model_copy(update={"output": content, "truncated": True})
    elif isinstance(details, CustomToolCallSummary) and details.copies_output:
        details = details.model_copy(
            update={
                "tool_result": None if spilled is not None else content,
                "structured_result": None,
                "spilled": spilled,
            }
        )
    elif details is None and spilled is not None:
        # The card of a result without details shows its content; it shows
        # the preview without the model's instructions instead.
        details = CustomToolCallSummary(
            tool_name=call.name, response_type="text", tool_result=None, spilled=spilled
        )
    if retained is not None:
        content = retained.output_prefix + content
    return result.model_copy(update={"content": content, "details": details})
