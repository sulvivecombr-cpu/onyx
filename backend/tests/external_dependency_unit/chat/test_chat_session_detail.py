"""The chat detail route against Postgres and the shared cache."""

from collections.abc import Sequence
from typing import Any
from uuid import uuid4

import pytest
from sqlalchemy.orm import Session

from onyx.cache.factory import get_cache_backend
from onyx.chat.chat_processing_checker import ChatTurnAdmission
from onyx.configs.constants import DEFAULT_PERSONA_ID, FileOrigin, MessageType
from onyx.db.chat import create_new_chat_message, get_or_create_root_message
from onyx.db.engine.sql_engine import get_session_with_current_tenant
from onyx.db.models import ChatMessage, ChatSession, User
from onyx.file_store.models import ChatFileType, FileDescriptor
from onyx.file_store.utils import save_chat_output_file
from onyx.server.query_and_chat import chat_backend
from tests.external_dependency_unit.conftest import MakeTestUser


@pytest.fixture
def owner(make_test_user: MakeTestUser) -> User:
    return make_test_user("chat-session-detail")


def test_an_idle_chat_detail_holds_the_saves_of_the_turn_that_ended(
    db_session: Session, owner: User, monkeypatch: pytest.MonkeyPatch
) -> None:
    chat = ChatSession(
        id=uuid4(),
        user_id=owner.id,
        persona_id=DEFAULT_PERSONA_ID,
        description="Read order",
    )
    db_session.add(chat)
    db_session.flush()
    root = ChatMessage(
        chat_session_id=chat.id,
        message="",
        token_count=0,
        message_type=MessageType.SYSTEM,
    )
    db_session.add(root)
    db_session.flush()
    question = ChatMessage(
        parent_message_id=root.id,
        chat_session_id=chat.id,
        message="Question",
        token_count=1,
        message_type=MessageType.USER,
    )
    db_session.add(question)
    db_session.commit()
    question_id = question.id

    turn = ChatTurnAdmission(get_cache_backend())
    turn.claim(chat.id)
    read_messages = chat_backend.get_chat_messages_by_session

    def read_then_end_turn(**kwargs: Any) -> Sequence[ChatMessage]:
        messages = read_messages(**kwargs)
        # The turn saves its reply and then releases admission, after the
        # route has read the messages.
        with get_session_with_current_tenant() as run_session:
            run_session.add(
                ChatMessage(
                    parent_message_id=question_id,
                    chat_session_id=chat.id,
                    message="Reply",
                    token_count=1,
                    message_type=MessageType.ASSISTANT,
                )
            )
            run_session.commit()
        turn.release()
        return messages

    monkeypatch.setattr(
        chat_backend, "get_chat_messages_by_session", read_then_end_turn
    )
    try:
        detail = chat_backend.get_chat_session(
            chat.id, user=owner, db_session=db_session
        )
    finally:
        turn.release()

    # A client stores an idle page as final, so an idle page must hold the reply.
    assert detail.is_processing or "Reply" in [
        message.message for message in detail.messages
    ]


@pytest.mark.usefixtures("initialize_file_store")
def test_a_paged_chat_detail_lists_every_file_published_on_the_branch(
    db_session: Session, owner: User
) -> None:
    """The model publishes files in two answers, and in an answer on another
    branch. A page that holds only the last answer still lists the branch's
    files, oldest first, and leaves out the other branch's file and files
    that the model did not publish."""
    chat = ChatSession(
        id=uuid4(),
        user_id=owner.id,
        persona_id=DEFAULT_PERSONA_ID,
        description="Published files",
    )
    db_session.add(chat)
    db_session.commit()

    def publish(name: str, content: bytes) -> FileDescriptor:
        file_id = save_chat_output_file(
            content,
            display_name=name,
            file_type="text/markdown",
            file_origin=FileOrigin.CHAT_ARTIFACT,
            chat_session_id=chat.id,
        )
        return FileDescriptor(id=file_id, type=ChatFileType.PLAIN_TEXT, name=name)

    def add(
        parent: ChatMessage,
        message_type: MessageType,
        files: list[FileDescriptor] | None = None,
    ) -> ChatMessage:
        return create_new_chat_message(
            chat_session_id=chat.id,
            parent_message=parent,
            message=message_type.value,
            token_count=1,
            message_type=message_type,
            db_session=db_session,
            files=files,
        )

    first = publish("report.md", b"# Draft")
    chart = publish("chart.md", b"# Chart")
    image = save_chat_output_file(
        b"png",
        display_name="image.png",
        file_type="image/png",
        file_origin=FileOrigin.CHAT_IMAGE_GEN,
        chat_session_id=chat.id,
    )
    second = publish("report.md", b"# Final")
    other_branch = publish("report.md", b"# Other")

    question = add(get_or_create_root_message(chat.id, db_session), MessageType.USER)
    first_answer = add(
        question,
        MessageType.ASSISTANT,
        [
            first,
            chart,
            FileDescriptor(id=image, type=ChatFileType.IMAGE, name="image.png"),
        ],
    )
    follow_up = add(first_answer, MessageType.USER)
    add(follow_up, MessageType.ASSISTANT, [other_branch])
    last_answer = add(follow_up, MessageType.ASSISTANT, [second])

    detail = chat_backend.get_chat_session(
        chat.id, limit=1, user=owner, db_session=db_session
    )

    assert detail.has_older_messages
    assert first_answer.id not in {message.message_id for message in detail.messages}
    assert [
        (file.file_id, file.name, file.mime_type, file.size, file.message_id)
        for file in detail.published_files
    ] == [
        (first["id"], "report.md", "text/markdown", len(b"# Draft"), first_answer.id),
        (chart["id"], "chart.md", "text/markdown", len(b"# Chart"), first_answer.id),
        (second["id"], "report.md", "text/markdown", len(b"# Final"), last_answer.id),
    ]
