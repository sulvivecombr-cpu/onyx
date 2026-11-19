"""The spill policy on results that it cannot save, and its step budget."""

from uuid import uuid4

import pytest

from onyx.agents.models import ToolResultContext
from onyx.llm.models import ToolCall, ToolResult, ToolResultMessage
from onyx.server.features.build.sandbox import harness_factory
from onyx.server.features.build.sandbox.harness_base import HarnessSandbox
from onyx.tools.tool_implementations.sandbox.models import (
    RetainedOutputResult,
    SandboxExecResult,
)
from onyx.tools.tool_implementations.sandbox.sandbox_tools import ExecCommandTool
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


_HEADER = "Wall time: 0.1000 seconds\nProcess exited with code 0\nOutput:\n"


def _without_sandbox(monkeypatch: pytest.MonkeyPatch) -> SandboxTurn:
    """A turn whose sandbox cannot be reached, so every spill write fails."""

    def unreachable() -> HarnessSandbox:
        raise RuntimeError("no sandbox")

    monkeypatch.setattr(harness_factory, "get_harness_sandbox", unreachable)
    return SandboxTurn(tenant_id="t", user_id=uuid4(), chat_session_id=uuid4())


def _exec_result(cut: str, retained: str, omitted_bytes: int) -> RetainedOutputResult:
    return RetainedOutputResult(
        content=_HEADER + cut,
        details=SandboxExecResult(
            output=cut,
            wall_time_seconds=0.1,
            exit_code=0,
            original_token_count=len(retained) // 4,
            truncated=True,
        ),
        output_prefix=_HEADER,
        retained_output=retained,
        omitted_bytes=omitted_bytes,
    )


def test_exec_output_that_the_vm_cannot_take_keeps_its_cut_and_the_dropped_bytes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    turn = _without_sandbox(monkeypatch)
    half = 512 << 10
    retained = "a" * half + "\n[... 900000 bytes omitted ...]\n" + "z" * half
    cut = "a" * 20_000 + "\n[... 250000 tokens omitted ...]\n" + "z" * 20_000

    result = spill_large_result(
        turn,
        ToolResultContext(
            message_id="run:0",
            calls=(ToolCall(id="call", name=ExecCommandTool.NAME, arguments={}),),
            result=_exec_result(cut, retained, 900_000),
            step_results=(),
        ),
    )

    # The model and the card keep the cut output, with a plain note that
    # names the bytes that the buffer dropped; the retained text goes no
    # further.
    output = (
        cut + "\n[The result was too large, and the sandbox could not save the "
        "full text, so the middle is left out. The sandbox had already dropped "
        "900,000 bytes from the middle of the output.]"
    )
    assert type(result) is ToolResult
    assert result.content == _HEADER + output
    assert isinstance(result.details, SandboxExecResult)
    assert result.details.output == output
    assert result.details.spilled is None
    assert "<persisted-output" not in output
    assert ExecCommandTool.NAME not in output


def test_the_step_budget_counts_the_cut_exec_output(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    turn = _without_sandbox(monkeypatch)
    # Under the limits of one result; the retained text would be over the
    # step budget, and the cut output is not.
    retained = "r" * 45_000
    cut = "c" * 10_000
    earlier = ToolResultMessage(
        content="e" * 185_000, tool_call_id="earlier", tool_name="fetch"
    )

    result = spill_large_result(
        turn,
        ToolResultContext(
            message_id="run:0",
            calls=(ToolCall(id="call", name=ExecCommandTool.NAME, arguments={}),),
            result=_exec_result(cut, retained, 0),
            step_results=(earlier,),
        ),
    )

    assert result.content == _HEADER + cut
    assert isinstance(result.details, SandboxExecResult)
    assert result.details.output == cut
