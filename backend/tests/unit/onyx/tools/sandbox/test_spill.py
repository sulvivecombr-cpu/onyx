"""The spill policy on results that it cannot save."""

from uuid import uuid4

from onyx.agents.models import ToolResultContext
from onyx.llm.models import ToolCall, ToolResult
from onyx.tools.tool_implementations.sandbox.spill import spill_large_result
from onyx.tools.tool_implementations.sandbox.turn import SandboxTurn
from onyx.tools.tool_implementations.utils import truncation_marker


def test_a_result_that_cannot_be_encoded_keeps_its_head_and_tail() -> None:
    # A lone surrogate has no UTF-8 encoding, so no file can hold the text.
    text = "a" * 30_000 + "\ud800" + "b" * 30_000
    turn = SandboxTurn(tenant_id="t", user_id=uuid4(), chat_session_id=uuid4())

    result = spill_large_result(
        turn,
        ToolResultContext(
            message_id="run:0",
            calls=(ToolCall(id="call", name="fetch", arguments={}),),
            result=ToolResult(content=text),
            step_results=(),
        ),
    )

    assert result.content == (
        "a" * 2_000
        + truncation_marker(len(text) - 3_000)
        + "b" * 1_000
        + "\n[The result was too large, and the sandbox could not save the full "
        "text, so the middle is left out.]"
    )
